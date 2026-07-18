# 计算器规则

## 版本
0.1

## 功能简介
成绩等级查找：分数段 → 等级（A/B/C/D），用 `VLOOKUP` 在分数下限表里查对应等级。演示 `VLOOKUP` 精确匹配（注意 VLOOKUP 是精确匹配，故用"分数本身"作 key，下限表用每档代表分）。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['姓名']},
  {op:'data', area:'B1', values:['分数']},
  {op:'data', area:'C1', values:['等级']},
  {op:'data', area:'A2:A4', values:['张三','李四','王五']},
  {op:'data', area:'B2:B4', values:[95, 82, 68]},
  // 等级映射表（代表分 -> 等级），放 E:F
  {op:'data', area:'E1', values:['代表分']},
  {op:'data', area:'F1', values:['等级']},
  {op:'data', area:'E2:E5', values:[95, 82, 68, 55]},
  {op:'data', area:'F2:F5', values:['A','B','C','D']},
  {op:'func', area:'C2',    values:['VLOOKUP(B2, E2:E5, F2:F5)']},
  {op:'copy', from:'C2',    to:'C3:C4'}
]
```
# 结果

| # | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| 1 | 姓名 | 分数 | 等级 |  | 代表分 | 等级 |
| 2 | 张三 | 95 | A |  | 95 | A |
| 3 | 李四 | 82 | B |  | 82 | B |
| 4 | 王五 | 68 | C |  | 68 | C |
| 5 |  |  |  |  | 55 | D |
