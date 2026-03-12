# Project Status

> Last updated: 2026-03-01
> Updated by: Zoe (roundtable synthesis)

## System Architecture

### Team Composition
| Agent | Role | Responsibilities |
|-------|------|-----------------|
| Zoe (main) | CEO / Orchestrator | Strategic decisions, roundtable moderation, priority management |
| TradingAgent | Quant Strategist | Trading strategy design, backtesting, risk analysis |
| MacroAgent | Macro Economist | Macro trends, Fed policy, cross-market analysis |
| AINewsAgent | Tech Intelligence | AI/ML developments, tech news curation |
| ArchitectAgent | System Architect | System design, infrastructure, tech evaluation |
| CodingAgent | Lead Developer | Code implementation, review, testing |
| PMAgent | Project Manager | Sprint planning, progress tracking, resource allocation |

### Tech Stack
- **LLM Backend**: OpenClaw Gateway on Mac Studio M1 Max (32GB)
- **Primary Model**: gmn/gpt-5.3-codex (via proxy)
- **Local Model**: Ollama qwen3:14b (health monitoring)
- **Communication**: Discord (multi-channel)
- **Deployment**: macOS launchctl service

## Current Focus

### Trading System Status
- **Strategy**: v0.1 defined - `market_state_machine + one_side_switch` with triple execution gate (signal + macro + risk)
- **Stage**: Roundtable consensus completed; entering implementation and validation
- **Key Metrics (MVP Acceptance)**:
  - Observation-only fallback exposure `<=20%` when any gate fails
  - One-side signal-day win rate over 10 trading days `>=55%`
  - Max daily drawdown `<=1.5%`
  - 20-day rolling drawdown improvement vs baseline `>=20%`
  - 5-day P/L ratio on capital-confirmed expansion days `>=1.3`
- **Known Issues**:
  - P0 market data pipeline not implemented yet (`DXY`, `US10Y`, `USDCNH`, `DR007`)
  - Backtest pipeline still missing macro regime and event-window filters
  - Weekly review cron job still needs reliability testing

### System Health
- Gateway: Running on port 18789
- Discord bots: All 5 bots online
- LLM connectivity: gmn/gpt-5.3-codex working (403 fix via User-Agent patch)
- Memory management: memoryFlush enabled (40k token threshold)
- Shared context: Configured and accessible by all agents

### Recent Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-28 | Kept gmn/gpt-5.3-codex as primary model | User preference, proxy connectivity verified |
| 2026-02-28 | Implemented User-Agent patch for 403 fix | OpenAI SDK sends identifying headers, proxy blocks them |
| 2026-02-28 | Set thinkingDefault to low | Reduce response latency and cost |
| 2026-03-01 | Set up shared-context directory | Enable project-aware discussions across all agents |
| 2026-03-01 | Adopted v0.1 strategy: `market_state_machine + one_side_switch` | Convert discretionary one-side exposure into explicit rule-based control |
| 2026-03-01 | Enabled macro gate for one-side exposure (`DXY`, `US10Y`, `USDCNH`) | Block one-side trades on macro conflict days |
| 2026-03-01 | Locked P0 data scope to 4 factors with SLA | Ensure reliable and timely signal generation (`5s` timeout, `1` retry, `>=3/4` fields) |
| 2026-03-01 | Added backtest macro/event filters (`macro_regime`, NFP/CPI/FOMC windows) | Reduce backtest-real trading drift and event-window tail risk |
| 2026-03-01 | Added final pre-trade triple gate with observation fallback (`<=20%`) | Prevent one-side drawdown from timing mismatch even when signal is directionally correct |

## Priorities

See `priorities.md` for the current priority stack.

## Open Questions
1. What specific trading strategies should we implement first?
2. What market data sources should we integrate?
3. How should we structure the backtesting pipeline?
4. Should we build a custom dashboard or use existing tools?
