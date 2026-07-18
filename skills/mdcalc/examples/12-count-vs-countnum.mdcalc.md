# 计算器规则

## 版本
0.1

## 功能简介
计数与求和对照：混合 num 与 text 的单元格，演示 `COUNT`（非空计数，任意类型）与 `COUNTNUM`（仅 num）的差异。注意：`SUM` 要求全 num，跨 text 会报错——故 SUM 只对纯数字单元格求（这里用显式相加 A2+A4+A6）。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['项']},
  {op:'data', area:'A2', values:[10]},
  {op:'data', area:'A3', values:['缺']},
  {op:'data', area:'A4', values:[20]},
  {op:'data', area:'A5', values:['无']},
  {op:'data', area:'A6', values:[30]},
  {op:'func', area:'A8',  values:['COUNT(A2:A6)']},
  {op:'func', area:'A9',  values:['COUNTNUM(A2:A6)']},
  {op:'func', area:'A10', values:['A2 + A4 + A6']}
]
```
# 结果

| # | A |
|---|---|
| 1 | 项 |
| 2 | 10 |
| 3 | 缺 |
| 4 | 20 |
| 5 | 无 |
| 6 | 30 |
| 7 |  |
| 8 | 5 |
| 9 | 3 |
| 10 | 60 |
