# Composer drawing board

Use the pencil button immediately to the right of the composer's `+` button to
sketch a UI. The dialog supports freehand drawing, a white eraser, outlined
rectangles and ellipses, arrows, and text (enter a label, then click to place it).
Color and stroke width are adjustable. Undo/redo retains up to 50 edits; clearing
the board is undoable.

“添加到会话” exports a white-background 1200 × 800 PNG through the existing image
attachment pipeline. It adds an attachment to the current draft, without sending
the message. Existing attachment limits and image preparation errors still apply.
The drawing remains editable when the dialog is closed, including after export.
Switching conversations or reloading discards the editable board; an already
attached image follows normal composer attachment persistence.

The editor uses pointer capture for mouse, pen and touch input and fixed document
coordinates across viewport sizes. Canceled gestures are discarded. A keyed
per-thread editor prevents asynchronous exports from attaching to another thread.
The dialog, controls, icons and adaptive composer layout reuse existing components.
No new dependency, backend endpoint or provider contract is required.
