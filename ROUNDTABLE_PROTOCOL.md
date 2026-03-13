# Roundtable Protocol for Shared-Channel Discussions

> Version: 2026-03-13-v1
> Status: Active protocol for multi-agent shared channels
> Scope: Human-readable shared channels (Discord, Slack, etc.)

> **See also**:
> - [Communication Model](README.md#communication-model--session-boundaries) — Agent/Session/Thread distinctions
> - [Positioning](README.md#positioning-why-this-approach-now) — why lightweight protocols for small teams

---

## What This Protocol Solves

**V1 (Collaborative Convergence)**: Ensures tasks get completed and results returned to the user.

**V2 (Shared-Channel Discussion Order)**: Ensures multiple agents in a shared channel don't talk over each other, while keeping the conversation human-readable.

This is **not** a fully automatic debate engine. It's a lightweight behavioral protocol for human-readable shared channels.

---

## V1 vs V2: Key Differences

| Aspect | V1 (Task Execution) | V2 (Shared-Channel Discussion) |
|--------|---------------------|-------------------------------|
| **Primary goal** | Task completion | Conversation order |
| **Channel type** | 1:1 orchestrator→worker | N:M shared channel |
| **Agent awakened** | Should execute task | **≠ Should speak** |
| **Routing mechanism** | `sessions_spawn` / `sessions_send` | `requireMention` + behavioral rules |
| **Turn structure** | Request → ACK → Result | Round with explicit handoffs |
| **Synthesis owner** | Orchestrator (Zoe) | Chair/orchestrator |

---

## Core Insight: Routing ≠ Behavior

`requireMention` and `ignoreOtherMentions` solve **routing** (who gets the message), not **behavior** (what they should do with it).

```
Routing layer (OpenClaw):
├─ requireMention: true    → Only process messages mentioning this agent
└─ ignoreOtherMentions: true → Don't respond to messages for other agents

Behavioral layer (This protocol):
├─ Only addressed agent speaks
├─ One turn = one complete message
├─ Explicit handoff to next agent
└─ Chair owns synthesis
```

**Both layers are needed.** Routing without behavioral protocol leads to:
- Agents responding to every mention (spam)
- Multiple agents speaking simultaneously (chaos)
- Incomplete thoughts split across messages (unreadable)
- No clear synthesis ownership (indecision)

---

## Minimal Rules for Public Roundtable

### Rule 1: Only Addressed Agent Speaks

```
❌ WRONG (agent1 speaks without being addressed):
User: @agent2 What about the macro view?
agent1: I think BTC will go up.

✅ CORRECT:
User: @agent2 What about the macro view?
agent2: From macro perspective...
      [complete thought]
      → handoff to next agent or chair
```

**Exception**: Chair/orchestrator may interject for facilitation.

### Rule 2: One Turn = One Complete Message

```
❌ WRONG (fragmented thought):
agent1: I think
agent1: BTC might
agent1: go up

✅ CORRECT:
agent1: I think BTC might go up because [reasoning].
       Key factors: [list].
       Confidence: [level].
       → handing off to @agent2 for trading perspective.
```

**Standard format**:
```
[Main point]
[Supporting reasoning]
[Confidence level]
[Optional: Handoff to next agent]
```

### Rule 3: Explicit Handoff to Next Agent

```
❌ WRONG (implicit handoff):
agent1: I think BTC will go up.
[Silence... everyone waits...]

✅ CORRECT:
agent1: I think BTC will go up because [reasoning].
       → @trading-agent, what's your view on entry timing?

Trading Agent: From trading perspective...
              → @macro-agent, any macro risks I'm missing?

Macro Agent: Macro risks include...
            → @zoe, ready for synthesis.
```

**Handoff markers**:
- `→ @agent-name, [question]` — direct question
- `→ @agent-name, your thoughts?` — open request
- `→ @zoe, ready for synthesis` — return to chair
- `→ open floor` — anyone can respond

### Rule 4: Chair/Owner Owns Final Synthesis

```
❌ WRONG (agent self-synthesizes):
agent1: I think BTC will go up. That's the final answer.

✅ CORRECT:
agent1: I think BTC will go up.
agent2: I see risks on the downside.
agent3: Macro supports cautious approach.

Zoe (Chair): Synthesis: [balanced conclusion].
            Action: [specific next step].
            → marking round complete.
```

**Chair responsibilities**:
- Decide when sufficient input gathered
- Provide balanced synthesis (not just last speaker wins)
- Declare round complete
- Assign action items

### Rule 5: New Round = New ack_id After Final

```
Round 1 (ack_id: round-20260313-001):
  User: @zoe Analyze BTC outlook
  Zoe: → @macro-agent, big picture?
  Macro: [analysis] → @trading-agent
  Trading: [analysis] → @zoe
  Zoe: [synthesis] → Round complete.

Round 2 (ack_id: round-20260313-002):
  User: @zoe What about ETH?
  [New round, fresh context]
```

**Why new ack_id matters**:
- Clear boundary between conversation contexts
- Prevents "bleed over" from previous rounds
- Enables proper logging and review
- Signals fresh start for all agents

---

## Mini Example Transcript

### Scenario: Multi-Agent Market Analysis

```markdown
[Discord #trading-roundtable]

user-sarah: @zoe BTC breaking 70k, should we enter long?

zoe: Acknowledged. Initiating market analysis round.
     ack_id: round-20250313-001
     → @macro-agent, what's the macro context?

macro-agent: Macro context:
            - Fed minutes tomorrow (high volatility risk)
            - Dollar index weakening (supportive)
            - ETF inflows strong this week

            Overall: Cautiously constructive.
            Confidence: 65%.
            → @trading-agent, technical view?

trading-agent: Technicals:
              - 70k breakout above 50-day MA
              - Volume profile supportive
              - But RSI at 72 (overbought short-term)

              Trading angle: Wait for pullback to 68.5k support.
              Confidence: 70%.
              → @news-agent, any event risks?

news-agent: Event risks:
           - SEC speech in 2 hours (regulatory risk)
           - No major economic data today

           Risk level: Medium.
           → @zoe, ready for synthesis.

zoe: Synthesis (ack_id: round-20250313-001):

     Bullish factors: ETF flows, weak dollar, technical breakout
     Bearish factors: Fed minutes tomorrow, overbought RSI, SEC speech

     Recommendation: Wait for pullback to 68.5k before entry.
     Risk: Medium. Timeframe: 24-48 hours.

     Action: @trading-agent monitor 68.5k level.
     → Round complete. New round requires new ack_id.

user-sarah: @zoe What about ETH instead?

zoe: Acknowledged. New analysis round.
     ack_id: round-20250313-002
     → @macro-agent, ETH correlation?

[Round 2 continues...]
```

---

## Protocol Templates

### Template 1: Agent Response

```markdown
[Main analysis/conclusion]

Supporting points:
- [Point 1]
- [Point 2]

Confidence: [low/medium/high] ([X]%)
→ [handoff to @agent or chair]
```

### Template 2: Chair Synthesis

```markdown
Synthesis (ack_id: [id]):

Key inputs:
- @agent1: [summary of view]
- @agent2: [summary of view]

Balanced conclusion:
[Neutral, comprehensive conclusion]

Recommendation:
[Specific action with confidence]

Next step:
[Specific assignment]
→ Round complete. New round requires new ack_id.
```

### Template 3: Handoff Request

```markdown
[Your analysis]

→ @specific-agent, [specific question]?
# or
→ @zoe, ready for synthesis.
# or
→ open floor for additional perspectives.
```

---

## Implementation Notes

### For OpenClaw Agent Configuration

```json
{
  "agent": {
    "name": "trading-agent",
    "requireMention": true,
    "ignoreOtherMentions": true,
    "systemPrompt": "You are part of a roundtable discussion. Follow these rules:\n\n1. Only speak when directly addressed\n2. One complete message per turn\n3. Always end with explicit handoff\n4. Never synthesize final decisions (that's Zoe's role)\n\nFormat:\n[Analysis]\nConfidence: [level]\n→ [handoff to next agent]"
  }
}
```

### For Channel Setup

```
Channel: #trading-roundtable
Purpose: Multi-agent market analysis
Chair: @zoe (sole synthesis owner)
Members: @trading-agent, @macro-agent, @news-agent
Protocol: Roundtable V2 (see docs)
```

---

## Limitations and Caveats

### What This Protocol Does NOT Solve

1. **Fully autonomous debate**: Agents don't spontaneously challenge each other. Handoffs are directed.

2. **Consensus building**: Agents state views; chair synthesizes. No iterative refinement rounds unless explicitly initiated.

3. **Long-running async discussions**: Designed for synchronous-ish chat. For async, use `sessions_spawn` with `task-log` tracking.

4. **Complex multi-round deliberation**: More than 3-4 agent turns may need breaking into separate rounds with new `ack_id`.

### When NOT to Use This Protocol

| Scenario | Better Alternative |
|----------|-------------------|
| 1:1 task execution | `sessions_spawn` / V1 protocol |
| Async multi-hour analysis | `sessions_spawn` + `task-log` |
| Need strict turn order enforcement | Custom orchestrator code |
| More than 5-6 agents | Consider topic-based sub-channels |

---

## Fit for Current Scale

This protocol is designed for:
- **3-5 agents** in a shared channel
- **Human-readable** conversation flow
- **Low-frequency** discussions (not high-frequency trading signals)
- **Human oversight** via chair/orchestrator

**Not designed for**:
- High-frequency automated trading
- Fully autonomous agent debates
- Large-scale multi-agent simulations

For those scenarios, consider heavier frameworks like AutoGen Core or LangGraph with proper message bus and graph-based orchestration.

---

## See Also

- [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) — base agent collaboration protocol
- [COMMUNICATION_ISSUES.md](COMMUNICATION_ISSUES.md) — communication layer design
- [Positioning](README.md#positioning-why-this-approach-now) — why lightweight for small teams

---

*Last updated: 2026-03-13 | Protocol version: v1*
