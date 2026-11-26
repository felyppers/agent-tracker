#!/usr/bin/env bash
# Mirrors Cursor agent progress into ~/.cursor/progress/<conversation>.json, so
# Agent Tracker sees a chat before Cursor writes its transcript. Progress is the
# latest "[NN%] ..." marker the agent printed this turn, else its to-do list
# (done/total).
#
# Registered for beforeSubmitPrompt, postToolUse, afterAgentResponse and stop.

input=$(cat)
event=$(jq -r '.hook_event_name // empty' <<<"$input" 2>/dev/null)

reply() {
  if [ "$event" = beforeSubmitPrompt ]; then printf '{"continue":true}\n'; else printf '{}\n'; fi
  exit 0
}

conv=$(jq -r '.conversation_id // empty' <<<"$input" 2>/dev/null)
[ -n "$conv" ] || reply

dir="$HOME/.cursor/progress"
mkdir -p "$dir"
state="$dir/$conv.json"
jq -e . "$state" >/dev/null 2>&1 || echo '{}' >"$state"

transcript=$(jq -r '.transcript_path // empty' <<<"$input")
turn=""
todos='{"total":0,"done":0,"current":null,"this_turn":false}'
if [ -n "$transcript" ] && [ -f "$transcript" ] && [ "$event" != beforeSubmitPrompt ]; then
  # Everything after the last user message is the current turn.
  turn=$(awk '/^\{"role":"user"/ { buf = ""; next } { buf = buf $0 "\n" } END { printf "%s", buf }' "$transcript")
  todo_calls='select(.role == "assistant") | .message.content[]? | select(.type == "tool_use")
    | if .name == "TodoWrite" then .input
      elif .name == "CallDynamicTool" and .input.toolName == "TodoWrite" then .input.arguments
      else empty end'
  replayed=$(grep -F TodoWrite "$transcript" | jq -c "$todo_calls" 2>/dev/null | jq -sc '
      reduce .[] as $c ({};
        if $c.merge then reduce ($c.todos // [])[] as $t (.; .[$t.id] = ((.[$t.id] // {}) + $t))
        else reduce ($c.todos // [])[] as $t ({}; .[$t.id] = $t) end)
      | [.[]] | {total: length,
                 done: map(select(.status == "completed" or .status == "cancelled")) | length,
                 current: (map(select(.status == "in_progress"))[0].content // null)}' 2>/dev/null)
  if [ -n "$replayed" ]; then
    this_turn=false
    grep -qF TodoWrite <<<"$turn" && this_turn=true
    todos=$(jq -c --argjson t "$this_turn" '. + {this_turn: $t}' <<<"$replayed")
  fi
fi

marker=$( { printf '%s' "$turn" | jq -r 'select(.role == "assistant") | .message.content[]? | select(.type == "text") | .text' 2>/dev/null
            jq -r '.text // empty' <<<"$input"; } \
  | grep -oE '\[[0-9]{1,3}%\][^[:cntrl:]]*' | tail -1 | sed -E 's/\*\*//g')

status=working
if [ "$event" = stop ]; then
  case "$(jq -r '.status // "completed"' <<<"$input")" in
    completed) status=done ;; aborted) status=aborted ;; *) status=error ;;
  esac
fi

ws=$(jq -r '.workspace_roots[0] // empty' <<<"$input")
tmp=$(mktemp "$dir/.tmp.XXXXXX")
jq -c \
  --arg event "$event" --arg status "$status" --arg marker "$marker" --argjson todos "$todos" \
  --arg model "$(jq -r '.model // empty' <<<"$input")" --arg ws "${ws##*/}" \
  --arg prompt "$(jq -r '.prompt // empty' <<<"$input" | tr '\n' ' ' | cut -c1-80)" \
  --argjson now "$(date +%s)" '
  . as $old
  | if $event == "beforeSubmitPrompt" then
      {task: $prompt, marker: null, todos: {total: 0, done: 0, current: null, this_turn: false}, started: $now}
    else
      {task: $old.task, started: $old.started,
       marker: (if $marker != "" then $marker else $old.marker end),
       todos: (if $todos.total > 0 then $todos else ($old.todos // $todos) end)}
    end
  | . + {status: $status,
         model: (if $model == "" then $old.model else $model end),
         workspace: (if $ws == "" then $old.workspace else $ws end),
         updated: $now}
  ' "$state" >"$tmp" && mv "$tmp" "$state"

reply
