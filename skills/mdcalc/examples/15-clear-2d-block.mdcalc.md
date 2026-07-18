# 计算器规则

## 版本
0.1

## 功能简介
2D 块清除：先填一个 A1:C3 的 3×3 表，再用 `clear A1:C3` 一次性整块清空（`clear` 是唯一允许 2D 区域的 op）。演示 `clear` 的 2D 能力 + 对比（其它 op 仍只能 1D）。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data',  area:'A1',  values:['行\列']},
  {op:'data',  area:'B1',  values:['X']},
  {op:'data',  area:'C1',  values:['Y']},
  {op:'data',  area:'A2',  values:['r1']},
  {op:'data',  area:'A3',  values:['r2']},
  {op:'data',  area:'B2:B3', values:[10, 40]},
  {op:'data',  area:'C2:C3', values:[20, 50]},
  // 整块清空数据区 B2:C3（保留表头与行名）
  {op:'clear', area:'B2:C3'}
]
```
# 结果

| # | A | B | C |
|---|---|---|---|
| 1 | 行列 | X | Y |
| 2 | r1 |  |  |
| 3 | r2 |  |  |
