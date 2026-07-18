# 计算器规则

## 版本
0.1

## 功能简介
提成分档：销售额 ≤10000 提成 5%，10000–50000 提成 8%，>50000 提成 12%。用 `IF` 嵌套判断 + `ROUND`。演示 `IF` 多层条件。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['销售员']},
  {op:'data', area:'B1', values:['销售额']},
  {op:'data', area:'C1', values:['提成率%']},
  {op:'data', area:'D1', values:['提成额']},
  {op:'data', area:'A2:A4', values:['甲','乙','丙']},
  {op:'data', area:'B2:B4', values:[8000, 30000, 60000]},
  {op:'func', area:'C2',    values:['IF(B2 > 50000, 12, IF(B2 > 10000, 8, 5))']},
  {op:'copy', from:'C2',    to:'C3:C4'},
  {op:'func', area:'D2',    values:['ROUND(B2 * C2 / 100, 2)']},
  {op:'copy', from:'D2',    to:'D3:D4'}
]
```
# 结果

| # | A | B | C | D |
|---|---|---|---|---|
| 1 | 销售员 | 销售额 | 提成率% | 提成额 |
| 2 | 甲 | 8000 | 5 | 400 |
| 3 | 乙 | 30000 | 8 | 2400 |
| 4 | 丙 | 60000 | 12 | 7200 |
