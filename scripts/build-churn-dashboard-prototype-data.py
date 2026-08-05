#!/usr/bin/env python3
"""从平台联盟工作表生成本机流失看板原型数据。"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import pandas as pd


def number(value) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def text(value) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def day_text(value) -> str:
    parsed = pd.to_datetime(value, errors="coerce")
    return "" if pd.isna(parsed) else parsed.strftime("%Y-%m-%d")


def mask_phone(value) -> str:
    digits = "".join(ch for ch in text(value) if ch.isdigit())
    if len(digits) == 11:
        return f"{digits[:3]}****{digits[-4:]}"
    return "-"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="美团订单统计 Excel 路径")
    parser.add_argument("output", help="输出 JSON 路径")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    raw = pd.read_excel(source, sheet_name="平台联盟")
    frame = raw.iloc[1:].copy()
    date_columns = [column for column in frame.columns if isinstance(column, str) and column.startswith("2026-")]
    complete_dates = [column for column in date_columns if column <= "2026-08-04"]
    current_date = "2026-08-05"
    for column in date_columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0)

    daily_totals = {date: int(frame[date].sum()) for date in complete_dates}
    recent_dates = complete_dates[-7:]
    previous_dates = complete_dates[-14:-7]
    baseline_dates = complete_dates[-10:-3]
    churn_dates = complete_dates[-3:]

    recent_average = sum(daily_totals[date] for date in recent_dates) / len(recent_dates)
    previous_average = sum(daily_totals[date] for date in previous_dates) / len(previous_dates)
    peak_date = max(complete_dates, key=lambda date: daily_totals[date])
    low_date = min(complete_dates, key=lambda date: daily_totals[date])

    users = []
    loss_count = 0
    risk_count = 0
    returned_count = 0
    for _, row in frame.iterrows():
        orders = [number(row.get(date)) for date in complete_dates]
        baseline_values = [number(row.get(date)) for date in baseline_dates]
        recent_values = [number(row.get(date)) for date in churn_dates]
        baseline_total = sum(baseline_values)
        baseline_average = baseline_total / len(baseline_values)
        latest_average = sum(recent_values) / len(recent_values)
        today_partial = number(row.get(current_date))

        status = "正常"
        reason = "近期订单保持稳定"
        if baseline_total > 0 and sum(recent_values) == 0:
            if today_partial > 0:
                status = "今日回流"
                returned_count += 1
                reason = f"连续3个完整日0单后，今日截至09:00恢复{today_partial:,}单，等待日终确认"
            else:
                status = "确认流失"
                loss_count += 1
                reason = f"参考7日有{baseline_total:,}单，最近3个完整日连续0单，今日仍为0"
        elif baseline_average >= 1 and latest_average > 0 and latest_average < baseline_average * 0.5:
            status = "高风险"
            risk_count += 1
            decline = (1 - latest_average / baseline_average) * 100
            reason = f"近3日日均较参考7日下降{decline:.1f}%，尚未连续3日0单"
        elif baseline_average > 0:
            change = (latest_average / baseline_average - 1) * 100
            if change < 0:
                reason = f"近3日日均较参考7日下降{abs(change):.1f}%，未达到风险阈值"
            else:
                reason = f"近3日日均较参考7日增长{change:.1f}%，状态正常"

        users.append(
            {
                "id": text(row.get("用户ID")),
                "accountsId": text(row.get("accounts_id")),
                "name": text(row.get("姓名")) or "未填写姓名",
                "phone": mask_phone(row.get("手机号")),
                "company": text(row.get("公司名称")) or "-",
                "version": text(row.get("当前版本")) or "-",
                "registeredAt": day_text(row.get("注册时间")) or "-",
                "authorized": text(row.get("是否授权美团")) or "-",
                "orders": orders,
                "todayPartial": today_partial,
                "status": status,
                "reason": reason,
            }
        )

    payload = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceName": source.name,
        "platform": "美团外卖",
        "currentDate": current_date,
        "completeThrough": complete_dates[-1],
        "dates": complete_dates,
        "dailyTotals": daily_totals,
        "metrics": {
            "recentAverage": round(recent_average),
            "previousAverage": round(previous_average),
            "recentChangePct": round((recent_average / previous_average - 1) * 100, 1),
            "peak": {"date": peak_date, "value": daily_totals[peak_date]},
            "low": {"date": low_date, "value": daily_totals[low_date]},
            "loss": loss_count,
            "highRisk": risk_count,
            "returnedToday": returned_count,
        },
        "users": users,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"已生成 {len(users)} 名用户；确认流失 {loss_count}；高风险 {risk_count}；今日回流 {returned_count}。"
    )


if __name__ == "__main__":
    main()
