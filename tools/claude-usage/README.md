# Claude Code 用量計算

從 Claude Code 的本機 session 紀錄算出訂閱方案的用量。

```bash
node claude-usage.mjs                 # 終端機檢視
node claude-usage.mjs --json          # 給 widget / 儀表板吃的 JSON（約 1.5 KB）
node claude-usage.mjs --calibrate 63  # 用官方 /usage 的讀數校正出百分比
```

需要 Node 18+，**必須在跑過 Claude Code 的那台機器上執行**。

## 資料從哪來

`~/.claude/projects/<專案>/<session>.jsonl` —— Claude Code 自己寫的逐筆紀錄。
每個 assistant 回合都帶著完整的 `usage`：

```json
{
  "timestamp": "2026-08-28T00:48:07.023Z",
  "message": {
    "model": "claude-opus-5",
    "usage": {
      "input_tokens": 2,
      "output_tokens": 1439,
      "cache_creation_input_tokens": 53908,
      "cache_read_input_tokens": 0,
      "output_tokens_details": { "thinking_tokens": 1173 }
    }
  }
}
```

這與官方 `/usage` 的來源一致——文件寫明那些數字是「近似值，由這台機器上的
本地 session 歷史計算」。**不碰任何未公開的網路端點，也不需要搬動憑證。**

## 5 小時視窗怎麼算

Claude Code 的視窗是「從那段時間的第一則訊息起算 5 小時」，不是整點對齊的
固定格子。所以這裡照同樣規則重建：遇到距離目前視窗起點超過 5 小時的紀錄，
就以它為起點開一個新視窗。

## 做得到與做不到

**做得到** —— 精確算出任一時間窗消耗的 token，分模型、分種類（輸入／輸出／
思考／快取寫入／快取讀取）。快取讀取另計，因為它的計價遠低於新輸入，混在
一起看會嚴重高估。

**做不到** —— 直接換算成「佔方案額度的百分比」。分母（方案上限的實際 token
數）Anthropic 沒有公開，本機檔案裡也沒有。

想要百分比，用 `--calibrate`：在 Claude Code 裡跑 `/usage` 看到讀數（例如
63%），然後 `node claude-usage.mjs --calibrate 63`，程式會反推出隱含的上限。

**校正會失效**，至少三種情況：換方案、Anthropic 調整政策、以及你的模型組合
改變（官方百分比很可能依模型加權，而加權方式沒有公開）。數字看起來不對就
重新校正一次。

## 為什麼不直接打 API

沒有這種 API。Anthropic 有文件的只有 `GET /v1/organizations/usage_report/messages`
和 `GET /v1/organizations/cost_report`，那兩個量的是**付費 API 組織的 token
用量與花費**，不是訂閱方案的 5 小時／每週額度。

Claude Code 內部確實有一個取得方案額度的端點（文件提到它「被速率限制」時
`/usage` 的降級行為），但沒有公開文件、沒有相容性承諾，隨時可能改。
