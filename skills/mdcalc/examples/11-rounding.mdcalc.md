# 计算器规则

## 版本
0.1

## 功能简介
舍入方式对比：同一组金额分别用 `ROUND/FLOOR/CEIL` 到 2 位小数，看差异。演示 `ROUND(x, d)`、`FLOOR`、`CEIL`。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['原始']},
  {op:'data', area:'B1', values:['ROUND2']},
  {op:'data', area:'C1', values:['FLOOR']},
  {op:'data', area:'D1', values:['CEIL']},
  {op:'data', area:'A2:A5', values:[12.345, 12.341, 7.891, 7.899]},
  {op:'func', area:'B2',    values:['ROUND(A2, 2)']},
  {op:'copy', from:'B2',    to:'B3:B5'},
  {op:'func', area:'C2',    values:['FLOOR(A2)']},
  {op:'copy', from:'C2',    to:'C3:C5'},
  {op:'func', area:'D2',    values:['CEIL(A2)']},
  {op:'copy', from:'D2',    to:'D3:D5'}
]
```
# 结果

| # | A | B | C | D |
|---|---|---|---|---|
| 1 | 原始 | ROUND2 | FLOOR | CEIL |
| 2 | 12.345 | 12.35 | 12 | 13 |
| 3 | 12.341 | 12.34 | 12 | 13 |
| 4 | 7.891 | 7.89 | 7 | 8 |
| 5 | 7.899 | 7.9 | 7 | 8 |
