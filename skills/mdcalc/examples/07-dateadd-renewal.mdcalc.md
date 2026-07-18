# 计算器规则

## 版本
0.1

## 功能简介
续期到期日：合同起始日 + 不同续期天数得到到期日。演示 `date` 起始日、`DATEADD` 加天数、`YEAR/MONTH/DAY` 拆分。注：无 TODAY()，起始日显式传入。

## 使用流程
1. 用 edit_file 向"操作记录"中的 ops 数组追加一个动作对象
2. 用 bash 运行 `mdcalc <file>` 对文件求值
3. 用 read_file 读取"# 结果"部分的表格

# 操作记录

```js
const ops = [
  {op:'data', area:'A1', values:['方案']},
  {op:'data', area:'B1', values:['起始日']},
  {op:'data', area:'C1', values:['续期天数']},
  {op:'data', area:'D1', values:['到期日']},
  {op:'data', area:'A2:A4',  values:['月度','季度','年度']},
  {op:'date', area:'B2:B4',  values:['2026-07-01','2026-07-01','2026-07-01']},
  {op:'data', area:'C2:C4',  values:[30, 90, 365]},
  {op:'func', area:'D2',     values:['DATEADD(B2, C2, "d")']},
  {op:'copy', from:'D2',     to:'D3:D4'}
]
```
# 结果

| # | A | B | C | D |
|---|---|---|---|---|
| 1 | 方案 | 起始日 | 续期天数 | 到期日 |
| 2 | 月度 | 2026-07-01 | 30 | 2026-07-31 |
| 3 | 季度 | 2026-07-01 | 90 | 2026-09-29 |
| 4 | 年度 | 2026-07-01 | 365 | 2027-07-01 |
