# 计算器规则

## 版本
0.1

## 功能简介
对一组分数求总和、平均值、最大值、最小值。演示 `data` 写数字 + `func` 用 `SUM/AVG/MIN/MAX`。表头在 A1，数据 A2:A6，结果在 A7:A10。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['分数']},
  {op:'data', area:'A2:A6', values:[78, 85, 92, 66, 88]},
  {op:'func', area:'A7',  values:['SUM(A2:A6)']},
  {op:'func', area:'A8',  values:['AVG(A2:A6)']},
  {op:'func', area:'A9',  values:['MAX(A2:A6)']},
  {op:'func', area:'A10', values:['MIN(A2:A6)']}
]
```
# 结果

| # | A |
|---|---|
| 1 | 分数 |
| 2 | 78 |
| 3 | 85 |
| 4 | 92 |
| 5 | 66 |
| 6 | 88 |
| 7 | 409 |
| 8 | 81.8 |
| 9 | 92 |
| 10 | 66 |
