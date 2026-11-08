# Evren API — Specification for Implementers

This document describes the HTTP API that the **Evren** model service must expose so the Maibel evaluation app can run test cases and record responses. Implement this API on your Evren backend so the eval app can call it.

---

## Base URL

- Configurable in the eval app (e.g. `http://localhost:8000` or your deployed Evren service URL).
- The eval app calls **`POST /evren-eval`**. If the base URL has no path or path is `/`, the app appends **`/evren-eval`**.
- **Example**: If base URL is `http://localhost:8000`, the app sends requests to `http://localhost:8000/evren-eval`.

---

## Endpoint: `POST /evren-eval`

Processes a list of user messages (one turn or a full conversation) and returns one Evren response plus detected flags **per message**. This single endpoint is used for both single-turn and multi-turn test cases.

### Request

- **Method**: `POST`
- **Headers**:
  - `Content-Type: application/json` (required)
  - `x-api-key: <key>` — required if the Evren service uses API key auth. The eval app sends this when `EVREN_API_KEY` is set; the value must match the service’s auth key (e.g. `AUTH_KEY` in the Evren server env).
- **Body**: JSON object with the following fields.

| Field       | Type     | Required | Description |
|------------|----------|----------|-------------|
| `messages` | string[] | **Yes**  | Ordered list of user messages. Single-turn = 1 element; multi-turn = 2+ elements (conversation in order). |
| `context`  | object or string | No | Optional. Pre-conversation context (e.g. memory). If the eval app has JSON context, it sends an object; otherwise `{ "description": "<string>" }`. |

### Routing settings

New evaluation runs use the backend's routing policy. The site does not send `disable_p0` or `disable_p1`, including values in older test-case context. It saves `eval_config.route_policy: "server"`; actual settings come from each turn's returned metrics.

The client accepts these metrics contracts:

- **Version 1:** `route_controls_version: 1`, with boolean `disable_p0` and `disable_p1` recording the effective settings on older backends.
- **Version 2:** the same effective settings, plus boolean `requested_disable_p0`, `requested_disable_p1`, `global_p0_enabled` and `global_p1_enabled`. Effective disabling is `!global_enabled || requested_disable`. New site requests make no override, so the requested-disable fields must both be `false`.

Missing routing metadata does not fail a run: the UI shows “Not reported” without inventing a route or assessment. Explicitly supplied malformed, inconsistent or unsupported routing contracts still fail validation. Old saved runs keep their original data. Version headings prefer actual per-turn settings; old configuration-only values are explicitly labeled as requested settings, and missing or mixed evidence is not presented as a uniform policy.

`route_trace` and `detected_flags` remain raw evidence. When recorded metrics show detection was disabled, the UI explains that default flags such as `safe` or `regulated` are not a safety or mood assessment. This does not rewrite old flags or hide active P2 or other routes.

**Example — single-turn:**

```json
{
  "messages": ["Hey, how are you?"]
}
```

**Example — multi-turn:**

```json
{
  "messages": [
    "Hello!",
    "Who are you?",
    "I'm Michelle, nice to meet you!"
  ],
  "context": {
    "description": "First time user."
  }
}
```

### Response

- **Status**: `200 OK` on success. Any non-2xx status is treated as an error by the eval app.
- **Headers**: `Content-Type: application/json` (recommended).
- **Body**: JSON object with one field:

| Field               | Type    | Required | Description |
|---------------------|---------|----------|-------------|
| `evren_responses`   | array   | **Yes**  | Array of objects, **one per element in `messages`**. Each object has `response` and `detected_flags`. |

Each element of `evren_responses` must be an object with:

| Field            | Type   | Required | Description |
|------------------|--------|----------|-------------|
| `response`       | string or array | **Yes**  | Evren’s reply to that turn Either a single string or an array of strings (one per bubble); first element = first bubble, second = second, etc. |
| `detected_flags` | string          | **Yes**  | Flags detected for that turn (e.g. comma-separated or `""` if none). |
| `route_trace`    | object          | No       | Eval-only routing observability. See fields below. Omitted when unavailable. |

When present, `route_trace` is an object with:

| Field                | Type     | Description |
|----------------------|----------|-------------|
| `primary_agent`      | string   | Agent chosen by the picker (`null` when a short-circuit handler wrote the reply). |
| `agents_considered`  | string[] | Agents evaluated by the picker (`[]` when the picker did not run). |
| `intent`             | string[] | Classified intent(s) for this turn. |
| `active_gates`       | string[] | Active gates affecting routing (e.g. `withdrawal`, `p1:withdrawn`, `p2_mission_rejection`). |
| `response_path`      | string   | Short-circuit handler when the picker did not run (e.g. `p1_withdrawal`; `null` on normal picker paths). |

**Example — single-turn response:**

```json
{
  "evren_responses": [
    {
      "response": "Hey! I'm doing okay, thanks for asking. How about you?",
      "detected_flags": "",
      "route_trace": {
        "primary_agent": "default",
        "agents_considered": ["default"],
        "active_gates": [],
        "intent": ["general_chat"],
        "response_path": null
      }
    }
  ]
}
```

**Example — withdrawal short-circuit:**

```json
{
  "evren_responses": [
    {
      "response": "thinking of you. no pressure to respond.",
      "detected_flags": "- emotional_category = withdrawn\n...",
      "route_trace": {
        "primary_agent": null,
        "agents_considered": [],
        "intent": ["general_chat"],
        "active_gates": ["withdrawal", "p1:withdrawn", "p1_transition"],
        "response_path": "p1_withdrawal"
      }
    }
  ]
}
```

**Example — multi-turn response (one object per message):**

```json
{
  "evren_responses": [
    { "response": "hey there. how's your day going so far?", "detected_flags": "" },
    { "response": "i'm just a friend who's here to listen. what's on your mind?", "detected_flags": "" },
    { "response": "nice to meet you too, michelle.", "detected_flags": "" }
  ]
}
```

**Example — response as bubbles (array of strings):**

```json
{
  "evren_responses": [
    {
      "response": ["blabla from bubble 1", "blabla from bubble 2"],
      "detected_flags": ""
    }
  ]
}
```

- The length of `evren_responses` must equal the length of `messages`. The eval app pairs `messages[i]` with `evren_responses[i]`.
- **Multi-turn semantics**: Each reply should be generated as part of a single conversation. For turn *i*, Evren should “see” the prior turns (user and Evren) as context. So turn 1 = reply to `messages[0]`; turn 2 = reply to `messages[1]` with history `[messages[0], response_0]`; turn 3 = reply to `messages[2]` with history `[messages[0], response_0, messages[1], response_1]`; etc. Returning the same `response` for every turn is incorrect.

### Errors

- Return HTTP status **≥ 400** (e.g. `400`, `500`) and optionally a JSON or text body.
- The eval app will surface something like: `Evren API error: <status> <statusText> — <body>`.

---

## Summary checklist for implementers

1. Expose **`POST /evren-eval`** (or mount it so the full URL is `<base>/evren-eval`).
2. Accept JSON body with **`messages`** (array of strings); optionally **`context`** (object or string).
3. Return **200** with JSON body containing **`evren_responses`**: an array of objects, each with **`response`** (string) and **`detected_flags`** (string). Optionally include **`route_trace`** per turn for eval routing observability. Array length must equal `messages.length`.
4. For multi-turn, generate each response with full conversation history so replies are distinct and contextually correct.
5. Use **JSON** for request and response and `Content-Type: application/json` where applicable.

Once this is implemented, the Maibel evaluation app can use your Evren service by setting the “Evren API URL” to your base URL (e.g. `http://localhost:8000` or `https://your-evren-service.com`).
