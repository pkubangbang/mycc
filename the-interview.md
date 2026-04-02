# The Interview: Project Roadmap Requirements

**Date**: 2026-04-02

---

## Vision & Goals

**Overall Goal**: Build a smart agent for an Ubuntu 24.04 laptop that acts as the "glue" to bring all the best things in the system together.

**Success Criteria**: The agent covers all daily tasks for the user.

**Key Use Cases**:
- Search the web and generate a report
- Dig through files to find hidden clues
- Integrate various system capabilities

---

## Technical Choices

**LLM**: Any Ollama-powered LLM that can use tools. Flexibility to use different models as needed.

**Platform**: Ubuntu 24.04 laptop

**Timeline**: Evolve over time to suit daily task needs (ongoing development)

---

## Current State

### What Works Well
- Basic tools (bash, read, write, edit)
- Dynamic loading system for tools and skills
- Todo and issue tracking (written but not fully tested)

### What Needs Improvement
- **Error handling and robustness** (top priority)
- **Teammate coordination** (tm_* tools valuable but frustrating)
- **Workflow enforcement** through prompt engineering

---

## Pain Points

### 1. Teammate Coordination (tm_* tools)
- **Challenge**: Managing which teammate does what, when, and how they work together
- **Value**: tm_* tools are the most valuable part of the system
- **Frustration**: The collaboration process is difficult to manage

### 2. Prompt Engineering
- **Challenge**: Enforcing certain workflow through prompts
- **Frustration**: Feeling overwhelmed about prompt engineering
- **Need**: Better mechanisms to ensure LLM follows intended processes

---

## Next Priorities

1. **Improve error handling and robustness** - Primary focus
2. **Better coordination mechanisms** - Make tm_* tools easier to use
3. **Workflow enforcement** - Better prompts or system design

---

## Future Vision

**Self-Evolving Agent**: The dream is for the agent to invent tools or skills on its own, leveraging the existing dynamic loading system.

---

## Notes

- Existing codebase is available at `/home/student/proj/mycc`
- The project has a premature but functional foundation to build upon
- User prefers iterative evolution based on daily needs