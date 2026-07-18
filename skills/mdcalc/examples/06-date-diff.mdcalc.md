# 计算器规则

## 版本
0.1

## 功能简介
项目工期：用 `DATEDIF` 计算各阶段天数与总工期。开工日期 + 各阶段结束日期，天数 = DATEDIF(开工, 结束, "d")。演示 `date` 写日期、`func` 跨单元格做差、`SUM` 汇总。注：无 TODAY()，所有日期显式传入。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['阶段']},
  {op:'data', area:'B1', values:['开工日']},
  {op:'data', area:'C1', values:['结束日']},
  {op:'data', area:'D1', values:['天数']},
  {op:'data', area:'A2:A4',  values:['设计','开发','测试']},
  {op:'date', area:'B2:B4',  values:['2026-03-01','2026-03-10','2026-04-05']},
  {op:'date', area:'C2:C4',  values:['2026-03-09','2026-04-04','2026-04-20']},
  {op:'func', area:'D2',     values:['DATEDIF(B2, C2, "d")']},
  {op:'copy', from:'D2',     to:'D3:D4'},
  {op:'func', area:'D5',     values:['SUM(D2:D4)']}
]
```
# 结果

| # | A | B | C | D |
|---|---|---|---|---|
| 1 | 阶段 | 开工日 | 结束日 | 天数 |
| 2 | 设计 | 2026-03-01 | 2026-03-09 | 8 |
| 3 | 开发 | 2026-03-10 | 2026-04-04 | 25 |
| 4 | 测试 | 2026-04-05 | 2026-04-20 | 15 |
| 5 |  |  |  | 48 |
