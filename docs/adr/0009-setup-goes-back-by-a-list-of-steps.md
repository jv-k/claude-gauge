# Setup goes back by a list of steps, and edits each row in place

- Status: accepted
- Date: 2026-11-03

## Context

The owner wanted three things in the setup questions: to go back to any earlier step, to change the order of the parts in a row and of the rows, and to add parts without a separate list to tick. Before this, the questions ran once from the first to the last, and a row's parts were a tick list that took the order in which they were ticked.

## Decision

- At any question, Esc goes back. A typed answer goes back with `<`. Setup lists the steps answered before the current one, each with its answer, and the user picks one. The list ends with the step the user is at, marked "← you are here"; picking it, or Esc at the list (Enter when typed), asks the same question again. The list holds the earlier steps only.
- After a jump back, setup asks each later step again in turn. Each offers the answer given last, so it takes one Enter to keep it. A row dropped when the number of rows goes down comes back with its parts if the number goes up again in the same run. "Keep them as they are", picked after changes, says that those changes are not written.
- All the rows are one step, the row editor: each row's parts side by side, then the add slot, "+", one row under another. ← and → move along a row, and Tab and Shift+Tab change row. ↑ and ↓ change the part at the cursor to another part not in its row, and the preview redraws at once. On the add slot, they make it a new part, and a new add slot follows. Shift with ← or → moves the part along its row, and Shift with ↑ or ↓ moves it to the row above or below, unless that row shows it already. Space, then the arrow keys, then Space does the same where a terminal does not send Shift. d, Backspace or Delete removes a part; a row left with no parts is not accepted. A row wraps onto more lines in a narrow terminal. The token line's parts use the same editor, with one row. The typed setup asks for each row on its own, as a typed row already gives its parts.
- The preview marks the row being edited with `❯` and the part at the cursor with `[ ]`, and shows a row with no parts yet as a faint line. The status line's own steps show the status line alone; the token line joins the preview from the question about it on.
- The bar style and cells questions show All, then the rows as the row editor does, each bar's part with its value and every other part faint. ← and →, or Tab and Shift+Tab, move between All and the bars the rows show, so a bar in no row cannot be picked, and its change would not show. ↑ and ↓ change the value, the preview puts the bar at the cursor in `[ ]`, and a note says what the value looks like. This replaces the tabs over a list that ADR 0008 described.
- With two or more rows, a step for the order of the rows follows the row editor: ↑ and ↓ select a row, shown in `[ ]` in the list and in the preview, Tab pushes it down and Shift+Tab up, and Enter accepts. The question for the number of rows stays.
- The typed setup has no order step. A typed row or token line keeps the order in which its parts are typed, so scripted answers keep working.

## Considered options

- **Esc goes back one step.** Rejected by the owner, who wanted to jump straight to any step.
- **A list of every answered step, before and after the current one.** Rejected: the later steps keep their answers, so each one is one Enter, and a short list reads faster.
- **A tick list, then a separate order step for each row.** Built first, then replaced: two questions per row, and the order step could already add and remove parts.
- **A list of parts that the add slot opens.** Rejected by the owner for ↑ and ↓ in place, which needs no extra list.
- **An add slot for rows, in place of the number of rows.** Rejected: the number keeps its preview for each count, and the rows' order step only reorders.
- **A rows-order question in the typed setup.** Rejected: typed answers already give the order, and a new question would break piped answers.
