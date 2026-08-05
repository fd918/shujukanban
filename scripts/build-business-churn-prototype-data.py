#!/usr/bin/env python3
"""Build a local-only prototype dataset from the business dashboard caches."""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUSINESS_CACHE = ROOT / "data/business-dashboard-cache.json"
USER_CACHE = ROOT / "data/business-user-detail-cache.json"
OUTPUT = ROOT / "data/private/business-churn-prototype-data.json"


def as_number(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def shift_day(day: str, offset: int) -> str:
    return (date.fromisoformat(day) + timedelta(days=offset)).isoformat()


def mask_phone(value: object) -> str:
    phone = "".join(char for char in str(value or "") if char.isdigit())
    if len(phone) >= 11:
        return f"{phone[:3]}****{phone[-4:]}"
    if len(phone) >= 7:
        return f"{phone[:3]}***{phone[-3:]}"
    return phone or "-"


def best_history_entries(items: dict) -> dict[str, tuple[tuple, dict, dict]]:
    selected: dict[str, tuple[tuple, dict, dict]] = {}
    for raw_key, payload in items.items():
        try:
            key = json.loads(raw_key)
        except json.JSONDecodeError:
            continue
        if key.get("type") not in {"history", "history-partial"}:
            continue
        platform_business_id = str(key.get("businessId") or "")
        if not platform_business_id:
            continue
        complete = payload.get("partial") is not True and payload.get("complete") is not False
        rows = payload.get("rows") or []
        dates = payload.get("dates") or []
        rank = (
            str(key.get("endDate") or ""),
            1 if complete else 0,
            len(rows),
            len(dates),
            str(payload.get("savedAtText") or ""),
        )
        if platform_business_id not in selected or rank > selected[platform_business_id][0]:
            selected[platform_business_id] = (rank, key, payload)
    return selected


def default_impact_threshold(users: list[dict]) -> int:
    active_baselines = sorted(user["baselineAvg"] for user in users if user["baselineAvg"] > 0)
    if not active_baselines:
        return 1
    index = min(len(active_baselines) - 1, math.floor(len(active_baselines) * 0.75))
    quartile = active_baselines[index]
    return max(1, min(30, round(quartile * 0.25)))


def build() -> dict:
    business_cache = json.loads(BUSINESS_CACHE.read_text(encoding="utf-8"))
    latest_key = sorted(business_cache)[-1]
    latest_payload = business_cache[latest_key]["payload"]
    current_date = str(latest_payload.get("dateRange", {}).get("endDate") or latest_key.split("_")[0])
    latest_complete_date = shift_day(current_date, -1)
    overall_trend = []
    platform_trends: dict[str, list[dict]] = defaultdict(list)
    for cache_key in sorted(business_cache):
        cache_payload = business_cache[cache_key].get("payload") or {}
        cache_date = str((cache_payload.get("dateRange") or {}).get("endDate") or cache_key.split("_")[0])
        if cache_date > latest_complete_date:
            continue
        overall_trend.append({
            "date": cache_date,
            "orders": round(as_number((cache_payload.get("summary") or {}).get("orders"))),
        })
        daily_platform_orders = defaultdict(float)
        for item in cache_payload.get("businesses") or []:
            daily_platform_orders[str(item.get("platform") or "其他")] += as_number(item.get("todayOrders"))
        for platform, orders in daily_platform_orders.items():
            platform_trends[platform].append({"date": cache_date, "orders": round(orders)})
    overall_trend = overall_trend[-30:]
    platform_trends = {platform: values[-30:] for platform, values in platform_trends.items()}

    businesses = latest_payload.get("businesses") or []
    by_platform_id = {str(item.get("platformBusinessId") or ""): item for item in businesses}
    user_cache = json.loads(USER_CACHE.read_text(encoding="utf-8"))
    histories = best_history_entries(user_cache.get("items") or {})

    details_by_platform_id: dict[str, dict] = {}
    platform_coverage = defaultdict(lambda: {"businesses": 0, "coveredBusinesses": 0, "coveredUsers": 0})

    for business in businesses:
        platform_coverage[str(business.get("platform") or "其他")]["businesses"] += 1

    for platform_business_id, (_, key, history) in histories.items():
        business = by_platform_id.get(platform_business_id)
        if not business or not history.get("rows"):
            continue
        available_dates = sorted(str(item) for item in (history.get("dates") or []) if str(item) <= latest_complete_date)
        if not available_dates:
            continue
        analysis_date = available_dates[-1]
        baseline_dates = [day for day in available_dates if day < analysis_date][-7:]
        if not baseline_dates:
            continue
        previous_date = baseline_dates[-1]
        display_dates = available_dates[-14:]
        normalized_users = []
        for row in history.get("rows") or []:
            days = {str(day): round(as_number(value)) for day, value in (row.get("days") or {}).items()}
            current_orders = round(as_number(days.get(analysis_date)))
            previous_orders = round(as_number(days.get(previous_date)))
            baseline_avg = round(sum(as_number(days.get(day)) for day in baseline_dates) / len(baseline_dates), 1)
            impact_orders = round(max(0, baseline_avg - current_orders), 1)
            increase_orders = round(max(0, current_orders - baseline_avg), 1)
            decline_pct = round((baseline_avg - current_orders) / baseline_avg * 100, 1) if baseline_avg > 0 else 0
            rise_pct = round((current_orders - baseline_avg) / baseline_avg * 100, 1) if baseline_avg > 0 else (100 if current_orders > 0 else 0)
            normalized_users.append({
                "name": str(row.get("name") or "未命名用户"),
                "id": str(row.get("id") or row.get("accountsId") or "-"),
                "accountsId": str(row.get("accountsId") or "-"),
                "phone": mask_phone(row.get("phone")),
                "version": str(row.get("version") or "-"),
                "registeredAt": str(row.get("registeredAt") or "-"),
                "company": str(row.get("company") or "-"),
                "currentOrders": current_orders,
                "previousOrders": previous_orders,
                "baselineAvg": baseline_avg,
                "impactOrders": impact_orders,
                "increaseOrders": increase_orders,
                "declinePct": decline_pct,
                "risePct": rise_pct,
                "daily": [round(as_number(days.get(day))) for day in display_dates],
            })
        normalized_users.sort(key=lambda item: (-item["impactOrders"], -item["baselineAvg"], item["name"]))
        platform = str(business.get("platform") or "其他")
        platform_coverage[platform]["coveredBusinesses"] += 1
        platform_coverage[platform]["coveredUsers"] += len(normalized_users)
        details_by_platform_id[platform_business_id] = {
            "analysisDate": analysis_date,
            "previousDate": previous_date,
            "baselineDates": baseline_dates,
            "displayDates": display_dates,
            "complete": history.get("partial") is not True and history.get("complete") is not False,
            "sourceRange": [str(key.get("startDate") or ""), str(key.get("endDate") or "")],
            "sourceRows": len(normalized_users),
            "defaultRule": {
                "impactThreshold": default_impact_threshold(normalized_users),
                "declinePct": 50,
                "risePct": 50,
                "mode": "and",
            },
            "users": normalized_users,
        }

    normalized_businesses = []
    for business in businesses:
        platform_business_id = str(business.get("platformBusinessId") or "")
        detail = details_by_platform_id.get(platform_business_id)
        today_orders = round(as_number(business.get("todayOrders")))
        yesterday_orders = round(as_number(business.get("yesterdayOrders")))
        change_pct = round((today_orders - yesterday_orders) / yesterday_orders * 100, 1) if yesterday_orders else (100 if today_orders else 0)
        normalized_businesses.append({
            "platform": str(business.get("platform") or "其他"),
            "name": str(business.get("name") or "未命名业务"),
            "businessId": str(business.get("businessId") or ""),
            "platformBusinessId": platform_business_id,
            "relatedUsers": round(as_number(business.get("users"))),
            "todayOrders": today_orders,
            "yesterdayOrders": yesterday_orders,
            "changePct": change_pct,
            "totalOrders": round(as_number(business.get("totalOrders"))),
            "detail": detail,
        })
    normalized_businesses.sort(key=lambda item: (-item["todayOrders"], item["platform"], item["name"]))

    return {
        "meta": {
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "latestDataTime": str(latest_payload.get("latestDataTime") or user_cache.get("savedAtText") or "-"),
            "currentDate": current_date,
            "latestCompleteDate": latest_complete_date,
            "businessCount": len(normalized_businesses),
            "coveredBusinessCount": len(details_by_platform_id),
            "coveredUserRows": sum(item["sourceRows"] for item in details_by_platform_id.values()),
            "note": "用户级判定默认排除当天，以最近完整自然日对比此前7日均值；业务层仍展示当天实时订单。",
        },
        "platformCoverage": dict(sorted(platform_coverage.items())),
        "overallTrend": overall_trend,
        "platformTrends": dict(sorted(platform_trends.items())),
        "businesses": normalized_businesses,
    }


def main() -> int:
    output = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else OUTPUT
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = build()
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(payload["meta"], ensure_ascii=False, indent=2))
    print(f"已写入：{output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
