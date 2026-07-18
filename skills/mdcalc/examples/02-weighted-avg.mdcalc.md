# 计算器规则

## 版本
0.1

## 功能简介
加权平均：成绩 × 学分 / 总学分。演示 `data` 多列 + `func` 跨行求和 + `copy`。
列：A 科目、B 成绩、C 学分、D 成绩×学分、E 累计；汇总行。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['科目']},
  {op:'data', area:'B1', values:['成绩']},
  {op:'data', area:'C1', values:['学分']},
  {op:'data', area:'D1', values:['成绩x学分']},
  {op:'data', area:'A2:A4', values:['数学','英语','物理']},
  {op:'data', area:'B2:B4', values:[90, 80, 85]},
  {op:'data', area:'C2:C4', values:[4, 3, 2]},
  {op:'func', area:'D2',     values:['B2 * C2']},
  {op:'copy', from:'D2',     to:'D3:D4'},
  {op:'func', area:'C5',     values:['SUM(C2:C4)']},
  {op:'func', area:'D5',     values:['SUM(D2:D4)']},
  {op:'func', area:'E5',     values:['ROUND(D5 / C5, 2)']}
]
```
# 结果

| # | A | B | C | D | E |
|---|---|---|---|---|---|
| 1 | 科目 | 成绩 | 学分 | 成绩x学分 |  |
| 2 | 数学 | 90 | 4 | 360 |  |
| 3 | 英语 | 80 | 3 | 240 |  |
| 4 | 物理 | 85 | 2 | 170 |  |
| 5 |  |  | 9 | 770 | 85.56 |
