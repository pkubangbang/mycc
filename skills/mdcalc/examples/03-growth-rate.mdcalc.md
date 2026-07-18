# 计算器规则

## 版本
0.1

## 功能简介
百分比与同比增长率。季度销售额 + 环比增长率 = (本期 − 上期) / 上期 × 100。
演示 `data` + `func` 用上一行单元格做差，`copy` 下行递推，`ROUND` 保留两位小数。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['季度']},
  {op:'data', area:'B1', values:['销售额']},
  {op:'data', area:'C1', values:['环比增长%']},
  {op:'data', area:'A2:A5', values:['Q1','Q2','Q3','Q4']},
  {op:'data', area:'B2:B5', values:[120000, 138000, 132000, 156000]},
  {op:'func', area:'C3',    values:['ROUND((B3 - B2) / B2 * 100, 2)']},
  {op:'copy', from:'C3',    to:'C4:C5'}
]
```
# 结果

| # | A | B | C |
|---|---|---|---|
| 1 | 季度 | 销售额 | 环比增长% |
| 2 | Q1 | 120000 |  |
| 3 | Q2 | 138000 | 15 |
| 4 | Q3 | 132000 | -4.35 |
| 5 | Q4 | 156000 | 18.18 |
