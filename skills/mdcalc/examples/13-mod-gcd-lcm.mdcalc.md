# 计算器规则

## 版本
0.1

## 功能简介
整除与公倍数：对几组数求 `MOD` 余数、`GCD` 最大公约数、`LCM` 最小公倍数。演示 `MOD/GCD/LCM` 与 `copy`。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['a']},
  {op:'data', area:'B1', values:['b']},
  {op:'data', area:'C1', values:['a mod b']},
  {op:'data', area:'D1', values:['GCD']},
  {op:'data', area:'E1', values:['LCM']},
  {op:'data', area:'A2:A4', values:[12, 100, 17]},
  {op:'data', area:'B2:B4', values:[5, 7, 5]},
  {op:'func', area:'C2',    values:['MOD(A2, B2)']},
  {op:'copy', from:'C2',    to:'C3:C4'},
  {op:'func', area:'D2',    values:['GCD(A2, B2)']},
  {op:'copy', from:'D2',    to:'D3:D4'},
  {op:'func', area:'E2',    values:['LCM(A2, B2)']},
  {op:'copy', from:'E2',    to:'E3:E4'}
]
```
# 结果

| # | A | B | C | D | E |
|---|---|---|---|---|---|
| 1 | a | b | a mod b | GCD | LCM |
| 2 | 12 | 5 | 2 | 1 | 60 |
| 3 | 100 | 7 | 2 | 1 | 700 |
| 4 | 17 | 5 | 2 | 1 | 85 |
