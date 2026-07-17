import fs from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve(process.argv[2] || "data/private/open-platform-profit-workbook.json");
const outputPath = path.resolve(process.argv[3] || "data/open-platform-profit-dashboard.json");

const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
const round = (value, digits = 2) => Number((Number(value || 0)).toFixed(digits));
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);

function excelDate(serial) {
  const milliseconds = Math.round((Number(serial) - 25569) * 86400 * 1000);
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function pctChange(current, previous) {
  if (!previous) return null;
  return round((current - previous) / Math.abs(previous), 4);
}

const months = [];
const projects = new Map();
const categories = new Map();
const daily = [];
let latestDate = "";

for (const sheet of source) {
  const values = sheet.values || [];
  if (values.length < 2) continue;

  const header = values[0];
  const projectRows = values.slice(1).filter((row) => {
    const name = String(row?.[2] || "").trim();
    return name && name !== "合计" && name !== "日平均值";
  });
  let carriedCategory = "未分类";
  const normalizedRows = projectRows.map((row) => {
    if (String(row?.[1] || "").trim()) carriedCategory = String(row[1]).trim();
    return { row, category: carriedCategory, project: String(row[2]).trim() };
  });

  const dateColumns = [];
  for (let column = 3; column < header.length - 1; column += 1) {
    if (typeof header[column] !== "number") continue;
    const hasActualValue = normalizedRows.some(({ row }) => row[column] !== null && row[column] !== undefined && row[column] !== "");
    if (!hasActualValue) continue;
    dateColumns.push({ column, date: excelDate(header[column]) });
  }

  const [sheetYear, sheetMonth] = sheet.sheet.split(".");
  const monthKey = `${sheetYear}-${String(sheetMonth).padStart(2, "0")}`;
  const monthDaily = [];
  const monthProjects = [];
  const monthCategories = new Map();

  for (const { row, category, project } of normalizedRows) {
    const series = dateColumns.map(({ column, date }) => ({ date, value: round(row[column]) }));
    const total = round(sum(series.map((item) => item.value)));
    monthProjects.push({ category, project, total, series });
    monthCategories.set(category, round((monthCategories.get(category) || 0) + total));

    if (!projects.has(project)) projects.set(project, { project, category, total: 0, monthly: [] });
    const projectEntry = projects.get(project);
    projectEntry.total = round(projectEntry.total + total);
    projectEntry.monthly.push({ month: monthKey, value: total });

    if (!categories.has(category)) categories.set(category, { category, total: 0, monthly: [] });
    categories.get(category).total = round(categories.get(category).total + total);
  }

  for (const { column, date } of dateColumns) {
    const contributions = normalizedRows.map(({ row, category, project }) => ({
      category,
      project,
      value: round(row[column]),
    }));
    const total = round(sum(contributions.map((item) => item.value)));
    const settlement = round(sum(contributions.filter((item) => ["月结技术服务费", "月结差额收益"].includes(item.project)).map((item) => item.value)));
    const software = round(sum(contributions.filter((item) => item.category === "软件销售").map((item) => item.value)));
    const operatingBase = round(total - settlement - software);
    const entry = { date, month: monthKey, total, settlement, software, operatingBase, contributions };
    monthDaily.push(entry);
    daily.push(entry);
    if (date > latestDate) latestDate = date;
  }

  const total = round(sum(monthDaily.map((item) => item.total)));
  months.push({
    month: monthKey,
    label: `${Number(monthKey.slice(5))}月`,
    days: monthDaily.length,
    total,
    dailyAverage: round(total / Math.max(monthDaily.length, 1)),
    operatingBase: round(sum(monthDaily.map((item) => item.operatingBase))),
    settlement: round(sum(monthDaily.map((item) => item.settlement))),
    software: round(sum(monthDaily.map((item) => item.software))),
    categories: [...monthCategories].map(([category, value]) => ({ category, value })),
    projects: monthProjects.map(({ category, project, total: value }) => ({ category, project, value })),
  });
}

for (const category of categories.values()) {
  category.monthly = months.map((month) => ({
    month: month.month,
    value: month.categories.find((item) => item.category === category.category)?.value || 0,
  }));
}

const latestMonthKey = latestDate.slice(0, 7);
const latestMonth = months.find((month) => month.month === latestMonthKey);
const previousMonth = months[months.findIndex((month) => month.month === latestMonthKey) - 1];
const latestDay = Number(latestDate.slice(8));
const previousSamePeriod = previousMonth
  ? round(sum(daily.filter((item) => item.month === previousMonth.month && Number(item.date.slice(8)) <= latestDay).map((item) => item.total)))
  : null;
const previousPeriodAverage = previousMonth
  ? round(previousSamePeriod / Math.max(daily.filter((item) => item.month === previousMonth.month && Number(item.date.slice(8)) <= latestDay).length, 1))
  : null;

const sortedDaily = [...daily].sort((a, b) => b.total - a.total);
const topDays = sortedDaily.slice(0, 10).map((item) => ({
  date: item.date,
  total: item.total,
  settlement: item.settlement,
  software: item.software,
  operatingBase: item.operatingBase,
  topContributors: [...item.contributions]
    .filter((entry) => entry.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 4),
}));

const latestMonthProjects = months
  .find((month) => month.month === latestMonthKey)
  ?.projects.slice().sort((a, b) => b.value - a.value) || [];
const projectList = [...projects.values()].sort((a, b) => b.total - a.total);
const categoryList = [...categories.values()].sort((a, b) => b.total - a.total);
const ytdTotal = round(sum(months.map((month) => month.total)));
const negativeProjects = projectList.filter((item) => item.total < 0);
const latestDayEntry = daily.find((item) => item.date === latestDate);
const previousDayEntry = daily[daily.findIndex((item) => item.date === latestDate) - 1];

const result = {
  meta: {
    title: "开放平台毛利看板",
    sourceFile: "开放平台毛利表2026.xlsx",
    sourceEmail: "蒋敏 <jiangmin@yunzhanxinxi.cn>",
    sourceEmailDate: "2026-07-16 17:30",
    latestDate,
    generatedAt: new Date().toISOString(),
    currency: "CNY",
    confidentiality: "内部经营数据，仅限本地使用",
  },
  summary: {
    ytdTotal,
    latestMonth: latestMonthKey,
    latestMonthTotal: latestMonth?.total || 0,
    latestMonthDailyAverage: latestMonth?.dailyAverage || 0,
    previousSamePeriodTotal: previousSamePeriod,
    samePeriodChangePct: pctChange(latestMonth?.total || 0, previousSamePeriod),
    previousPeriodAverage,
    dailyAverageChangePct: pctChange(latestMonth?.dailyAverage || 0, previousPeriodAverage),
    latestDayTotal: latestDayEntry?.total || 0,
    latestDayChangePct: pctChange(latestDayEntry?.total || 0, previousDayEntry?.total || 0),
    latestMonthOperatingBase: latestMonth?.operatingBase || 0,
    latestMonthSettlement: latestMonth?.settlement || 0,
    latestMonthSoftware: latestMonth?.software || 0,
    settlementAndSoftwareShare: latestMonth?.total ? round((latestMonth.settlement + latestMonth.software) / latestMonth.total, 4) : 0,
  },
  months,
  categories: categoryList,
  projects: projectList,
  latestMonthProjects,
  negativeProjects,
  daily: daily.map(({ contributions, ...item }) => item),
  topDays,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
console.log(`已生成：${outputPath}`);
console.log(JSON.stringify(result.summary, null, 2));
