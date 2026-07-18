# 计算器规则

## 版本
0.1

## 功能简介
工时与时长：用 `time` 写上下班时间，`datetime` 写带日期的时刻，再用 `DATEDIF` 秒差换算小时。演示 `time`/`datetime` 类型 + `DATEDIF(..., "s")` 转秒再除 3600 得小时。注：时间比较需用 TIMESTAMP 转秒，这里用 datetime 直接做秒差。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data',     area:'A1', values:['日期']},
  {op:'data',     area:'B1', values:['上班']},
  {op:'data',     area:'C1', values:['下班']},
  {op:'data',     area:'D1', values:['工时(h)']},
  {op:'date',     area:'A2:A3',  values:['2026-07-01','2026-07-02']},
  {op:'datetime', area:'B2:B3',  values:['2026-07-01T09:00:00','2026-07-02T09:30:00']},
  {op:'datetime', area:'C2:C3',  values:['2026-07-01T18:00:00','2026-07-02T18:30:00']},
  {op:'func',     area:'D2',     values:['ROUND(DATEDIF(B2, C2, "s") / 3600, 2)']},
  {op:'copy',     from:'D2',     to:'D3:D3'}
]
```
# 结果

| # | A | B | C | D |
|---|---|---|---|---|
| 1 | 日期 | 上班 | 下班 | 工时(h) |
| 2 | 2026-07-01 | 2026-07-01 09:00:00 | 2026-07-01 18:00:00 | 9 |
| 3 | 2026-07-02 | 2026-07-02 09:30:00 | 2026-07-02 18:30:00 | 9 |
