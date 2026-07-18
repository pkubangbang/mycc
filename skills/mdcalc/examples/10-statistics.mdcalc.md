# 计算器规则

## 版本
0.1

## 功能简介
统计描述：对一组身高数据求和、均值、最小、最大、中位数、标准差、方差、计数。演示聚合函数集合 `SUM/AVG/MIN/MAX/MEDIAN/STDDEV/VAR/COUNT/COUNTNUM`。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['身高']},
  {op:'data', area:'A2:A8', values:[170, 165, 180, 158, 172, 169, 177]},
  {op:'func', area:'A10', values:['COUNT(A2:A8)']},
  {op:'func', area:'A11', values:['COUNTNUM(A2:A8)']},
  {op:'func', area:'A12', values:['SUM(A2:A8)']},
  {op:'func', area:'A13', values:['ROUND(AVG(A2:A8), 2)']},
  {op:'func', area:'A14', values:['MIN(A2:A8)']},
  {op:'func', area:'A15', values:['MAX(A2:A8)']},
  {op:'func', area:'A16', values:['MEDIAN(A2:A8)']},
  {op:'func', area:'A17', values:['ROUND(STDDEV(A2:A8), 2)']},
  {op:'func', area:'A18', values:['ROUND(VAR(A2:A8), 2)']}
]
```
# 结果

| # | A |
|---|---|
| 1 | 身高 |
| 2 | 170 |
| 3 | 165 |
| 4 | 180 |
| 5 | 158 |
| 6 | 172 |
| 7 | 169 |
| 8 | 177 |
| 9 |  |
| 10 | 7 |
| 11 | 7 |
| 12 | 1191 |
| 13 | 170.14 |
| 14 | 158 |
| 15 | 180 |
| 16 | 170 |
| 17 | 6.79 |
| 18 | 46.12 |
