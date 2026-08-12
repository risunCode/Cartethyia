# Cline Model Survey — 2026-08-12

- Catalog models tested: **406**
- Probe mode: normal Cline account probe; local Cartethyia health cooldown was reset between models so one failure did not stop the survey.
- Billing: Cline provider credit enforcement was not bypassed. The upstream "Insufficient balance" response was recorded and the next model continued.
- PASS: **10**
- Credit blocked: **392**
- Transient/unresolved: **4**

## Confirmed usable

| Model | Class | Latency | Returned model |
| --- | --- | ---: | --- |
| `cohere/north-mini-code:free` | free-labeled | 9699 ms | `cohere/north-mini-code:free` |
| `deepseek/deepseek-v4-flash` | non-free catalog ID | 8226 ms | `deepseek/deepseek-v4-flash-0731` |
| `google/gemma-4-26b-a4b-it:free` | free-labeled | 1354 ms | `google/gemma-4-26b-a4b-it:free` |
| `google/gemma-4-31b-it:free` | free-labeled | 2221 ms | `google/gemma-4-31b-it:free` |
| `inclusionai/ling-3.0-tiny:free` | free-labeled | 1488 ms | `inclusionai/ling-3.0-tiny:free` |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | free-labeled | 6869 ms | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| `nvidia/nemotron-3.5-content-safety:free` | free-labeled | 3331 ms | `nvidia/nemotron-3.5-content-safety:free` |
| `nvidia/nemotron-3.5-lightning:free` | free-labeled | 5607 ms | `nvidia/nemotron-3.5-lightning:free` |
| `poolside/laguna-s-2.1:free` | free-labeled | 4473 ms | `poolside/laguna-s-2.1:free` |
| `poolside/laguna-xs-2.1:free` | free-labeled | 1557 ms | `poolside/laguna-xs-2.1:free` |

## Free-labeled catalog results

Tested **16** models: **9 PASS**, **4 credit blocked**, **3 transient/unresolved**.

| Model | Result | Evidence |
| --- | --- | --- |
| `cohere/north-mini-code:free` | PASS | 9699 ms; returned `cohere/north-mini-code:free` |
| `google/gemma-4-26b-a4b-it:free` | PASS | 1354 ms; returned `google/gemma-4-26b-a4b-it:free` |
| `google/gemma-4-31b-it:free` | PASS | 2221 ms; returned `google/gemma-4-31b-it:free` |
| `inclusionai/ling-3.0-tiny:free` | PASS | 1488 ms; returned `inclusionai/ling-3.0-tiny:free` |
| `liquid/lfm-2.5-2.6b:free` | TRANSIENT | Upstream connection timed out |
| `nvidia/nemotron-3-nano-30b-a3b:free` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | PASS | 6869 ms; returned `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| `nvidia/nemotron-3-super-120b-a12b:free` | TRANSIENT | Upstream connection timed out |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | TRANSIENT | Upstream connection timed out |
| `nvidia/nemotron-3.5-content-safety:free` | PASS | 3331 ms; returned `nvidia/nemotron-3.5-content-safety:free` |
| `nvidia/nemotron-3.5-lightning:free` | PASS | 5607 ms; returned `nvidia/nemotron-3.5-lightning:free` |
| `nvidia/nemotron-nano-12b-v2-vl:free` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-nano-9b-v2:free` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-oss-20b:free` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `poolside/laguna-s-2.1:free` | PASS | 4473 ms; returned `poolside/laguna-s-2.1:free` |
| `poolside/laguna-xs-2.1:free` | PASS | 1557 ms; returned `poolside/laguna-xs-2.1:free` |

## Non-free catalog results

Tested **390** models: **1 PASS**, **388 credit blocked**, **1 transient/unresolved**.

| Model | Result | Evidence |
| --- | --- | --- |
| `ai21/jamba-large-1.7` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `aion-labs/aion-2.0` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `aion-labs/aion-3.0` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `aion-labs/aion-3.0-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `aion-labs/aion-rp-llama-3.1-8b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `allenai/olmo-3-32b-think` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `amazon/nova-2-lite-v1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `amazon/nova-lite-v1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `amazon/nova-micro-v1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `amazon/nova-premier-v1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `amazon/nova-pro-v1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthracite-org/magnum-v4-72b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-3-haiku` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-fable-5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-fable-5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-haiku-4.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-haiku-4.5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.1:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.6` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.6:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.7` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.7-fast` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.7:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.8` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.8-fast` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-4.8:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-5-fast` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-opus-5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-4` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-4.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-4.5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-4.6` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-4.6:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `anthropic/claude-sonnet-5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `arcee-ai/trinity-large-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `arcee-ai/virtuoso-large` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `baidu/ernie-4.5-vl-424b-a47b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `bytedance-seed/seed-1.6` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `bytedance-seed/seed-1.6-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `bytedance-seed/seed-2.0-code` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `bytedance-seed/seed-2.0-lite` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `bytedance-seed/seed-2.0-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `bytedance/ui-tars-1.5-7b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `cognitivecomputations/dolphin-mistral-24b-venice-edition` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `cohere/command-a` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `cohere/command-r-08-2024` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `cohere/command-r-plus-08-2024` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `cohere/command-r7b-12-2024` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepcogito/cogito-v2.1-671b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-chat` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-chat-v3-0324` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-chat-v3.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-r1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-r1-0528` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-r1-distill-llama-70b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-v3.1-terminus` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-v3.2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-v3.2-exp` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-v4-flash` | PASS | 8226 ms; returned `deepseek/deepseek-v4-flash-0731` |
| `deepseek/deepseek-v4-flash-0731` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `deepseek/deepseek-v4-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-flash-image` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-flash-lite` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-flash-lite:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-flash:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-pro-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-pro-preview-05-06` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-2.5-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3-flash-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3-flash-preview:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3-pro-image` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3-pro-image-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-flash-image` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-flash-image-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-flash-lite` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-flash-lite-image` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-flash-lite-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-flash-lite:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-pro-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-pro-preview-customtools` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.1-pro-preview:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.5-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.5-flash-lite` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.5-flash-lite:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.5-flash:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.6-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemini-3.6-flash:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-2-27b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-3-12b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-3-27b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-3-4b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-3n-e4b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-4-26b-a4b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/gemma-4-31b-it` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/lyria-3-clip-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `google/lyria-3-pro-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `gryphe/mythomax-l2-13b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `ibm-granite/granite-4.0-h-micro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `ibm-granite/granite-4.1-8b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `inception/mercury-2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `inclusionai/ling-2.6-1t` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `inclusionai/ling-2.6-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `inclusionai/ling-3.0-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `inclusionai/ring-2.6-1t` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `kwaipilot/kat-coder-air-v2.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `kwaipilot/kat-coder-pro-v2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `kwaipilot/kat-coder-pro-v2.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mancer/weaver` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meituan/longcat-2.0` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-3.1-70b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-3.1-8b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-3.2-1b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-3.2-3b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-3.3-70b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-4-maverick` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-4-scout` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta-llama/llama-guard-4-12b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta/muse-glimmer-30b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta/muse-spark-1.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `meta/muse-spark-1.2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `microsoft/phi-4` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `microsoft/wizardlm-2-8x22b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-01` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m2-her` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m2.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m2.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m2.7` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `minimax/minimax-m3:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/codestral-2508` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/ministral-14b-2512` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/ministral-3b-2512` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/ministral-8b-2512` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-large` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-large-2407` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-large-2512` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-medium-3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-medium-3-5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-medium-3.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-nemo` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-saba` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-small-24b-instruct-2501` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-small-2603` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-small-3.1-24b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mistral-small-3.2-24b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/mixtral-8x22b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `mistralai/voxtral-small-24b-2507` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2-0905` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2.6` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2.7-code` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k2.7-code:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `moonshotai/kimi-k3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `morph/morph-v3-fast` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `morph/morph-v3-large` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nex-agi/nex-n2-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nex-agi/nex-n2-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nousresearch/hermes-3-llama-3.1-405b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nousresearch/hermes-3-llama-3.1-70b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nousresearch/hermes-4-405b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nousresearch/hermes-4-70b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-3-nano-30b-a3b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-3-super-120b-a12b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-3-ultra-550b-a55b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-3-ultra-550b-a55b:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `nvidia/nemotron-3.5-lightning` | TRANSIENT | Upstream provider returned HTTP 500 |
| `openai/gpt-3.5-turbo` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-3.5-turbo-0613` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-3.5-turbo-16k` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-3.5-turbo-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-3.5-turbo:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4-turbo` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4-turbo-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4-turbo:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4.1-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4.1-mini:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4.1-nano` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4.1-nano:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4.1:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o-2024-05-13` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o-2024-08-06` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o-2024-11-20` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o-mini-2024-07-18` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o-mini:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-4o:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-codex:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-image` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-image-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-mini:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-nano` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-nano:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.1-codex` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.1-codex-max` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.1-codex-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.1:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.2-chat` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.2-codex` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.2-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.2-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.2:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.3-codex` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-image-2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-mini:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-nano` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-nano:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.4:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.5-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.5-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-luna` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-luna-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-luna-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-luna:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-sol` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-sol-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-sol-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-sol:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-terra` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-terra-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-terra-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5.6-terra:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-5:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-audio` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-audio-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-chat-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-oss-120b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-oss-20b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/gpt-oss-safeguard-20b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o1-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o1-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o1:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3-mini-high` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3-mini-high:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3-mini:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3-pro:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o3:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o4-mini` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o4-mini-high` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o4-mini-high:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openai/o4-mini:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openrouter/auto` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openrouter/auto-beta` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openrouter/bodybuilder` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openrouter/free` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openrouter/fusion` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `openrouter/pareto-code` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `perceptron/perceptron-mk1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `perplexity/sonar` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `perplexity/sonar-deep-research` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `perplexity/sonar-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `perplexity/sonar-pro-search` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `perplexity/sonar-reasoning-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `poolside/laguna-s-2.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `poolside/laguna-xs-2.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen-2.5-72b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen-2.5-7b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen-2.5-coder-32b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen-plus` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen-plus-2025-07-28` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen-plus-2025-07-28:thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen2.5-vl-72b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-14b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-235b-a22b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-235b-a22b-2507` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-235b-a22b-thinking-2507` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-30b-a3b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-30b-a3b-instruct-2507` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-30b-a3b-thinking-2507` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-32b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-8b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-coder` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-coder-30b-a3b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-coder-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-coder-next` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-coder-plus` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-max` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-max-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-next-80b-a3b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-next-80b-a3b-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-235b-a22b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-235b-a22b-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-30b-a3b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-30b-a3b-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-32b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-8b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3-vl-8b-thinking` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-122b-a10b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-27b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-35b-a3b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-397b-a17b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-9b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-flash-02-23` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-plus-02-15` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.5-plus-20260420` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.6-27b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.6-35b-a3b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.6-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.6-max-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.6-plus` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.7-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.7-max` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.7-plus` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `qwen/qwen3.8-max` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `rekaai/reka-edge` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `rekaai/reka-flash-3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `relace/relace-apply-3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `relace/relace-search` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `sakana/fugu-ultra` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `sakana/sakana-namazu` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `sao10k/l3-lunaris-8b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `sao10k/l3.1-euryale-70b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `sao10k/l3.3-euryale-70b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `stepfun/step-3.5-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `stepfun/step-3.7-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `tencent/hunyuan-a13b-instruct` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `tencent/hy3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `tencent/hy3-preview` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thedrummer/cydonia-24b-v4.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thedrummer/rocinante-12b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thedrummer/skyfall-36b-v2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thedrummer/unslopnemo-12b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thinkingmachines/inkling` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thinkingmachines/inkling-small` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `thinkingmachines/inkling:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `undi95/remm-slerp-l2-13b` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `upstage/solar-pro-3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `upstage/solar-pro4` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `writer/palmyra-x5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `x-ai/grok-4.20` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `x-ai/grok-4.20-multi-agent` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `x-ai/grok-4.3` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `x-ai/grok-4.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `x-ai/grok-build-0.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `xiaomi/mimo-v2.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `xiaomi/mimo-v2.5-pro` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.5-air` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.5v` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.6` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.6v` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.7` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-4.7-flash` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-5` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-5-turbo` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-5.1` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-5.2` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-5.2:batch` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `z-ai/glm-5v-turbo` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~anthropic/claude-fable-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~anthropic/claude-haiku-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~anthropic/claude-opus-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~anthropic/claude-sonnet-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~deepseek/deepseek-v4-flash-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~google/gemini-flash-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~google/gemini-pro-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~moonshotai/kimi-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~openai/gpt-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~openai/gpt-mini-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |
| `~x-ai/grok-latest` | CREDIT_BLOCKED | Insufficient balance. Your Cline Credits balance is $0.01 |

## Interpretation

- `PASS` means the actual Cline account returned a successful model response during this survey.
- `CREDIT_BLOCKED` means Cline itself rejected the request because the account balance is `$0.01`; this is not treated as a free/usable result.
- `TRANSIENT` means the request reached the probe but ended in timeout or HTTP 500; it is not classified as paid or free.
- A non-free catalog ID can still pass when Cline aliases it to another upstream model; keep the returned-model column when choosing a route.
- Results are time-, account-, and provider-state-dependent; rerun after catalog or Cline account changes.
