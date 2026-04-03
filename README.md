# SimCo 航空市场分析器

一个 [Tampermonkey](https://www.tampermonkey.net/) 用户脚本，用于在 [SimCompanies](https://www.simcompanies.com/) 游戏中实时抓取并解析航空聊天室的买卖报价。

## 支持产品

| 代码 | 名称 | 别名 |
|------|------|------|
| `:re-91:` | SOR | sor, sors |
| `:re-94:` | BFR | bfr, bfrs |
| `:re-95:` | JUM | jum, jumbo, jumbos, jumbojet |
| `:re-96:` | LUX | lux, luxs, luxjet |
| `:re-97:` | SEP | sep, seps |
| `:re-99:` | SAT | sat, sats, satellite |

## 安装

1. 浏览器安装 [Tampermonkey 扩展](https://www.tampermonkey.net/)
2. 点击 [Raw 链接](../../raw/main/simco_market_analyzer.user.js) 自动触发安装，或手动复制代码到 Tampermonkey 新建脚本
3. 刷新 simcompanies.com，右下角出现 **✈ 市场** 按钮

## 使用

1. 点击 **✈ 市场** 打开面板
2. 设置搜索时间范围（默认 8 小时）
3. 点击 **🔍 搜索** 开始抓取
4. 结果按产品 / 质量等级展示买卖双方报价

```
等级   BUY              SELL
Q4    88.5k×1          90k×1  92k×1
Q5    90k×1  93k×1    94k×1  94.5k×1
?     ×4（无报价买家） ×2
```

> 鼠标悬停在价格上可查看报价公司名称  
> 📋 按钮可将完整结果复制为 JSON

## 功能特性

- **直接调用游戏 API**，无需手动复制粘贴聊天记录
- **`+/-Xk/Q` 报价自动展开**到 Q0–Q9 每个等级
- 租借相关消息自动过滤，不纳入报价统计
- 同一公司对同产品/等级/价格仅计一次（去重）
- 可拖动面板，随时停止搜索

## 注意

脚本运行在 simcompanies.com 同源下，使用浏览器已登录的 Cookie，无需额外授权。
