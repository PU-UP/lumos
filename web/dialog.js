'use strict';
function dismissOnBackdrop(dialog, dismiss = () => {
  // Follow Escape's cancellation path so pending writes and completion choices stay safe.
  if (dialog.dispatchEvent(new Event('cancel', {cancelable:true}))) dialog.close();
}) {
  let startedOutside = false;
  const outside = event => {
    if (event.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  dialog.addEventListener('pointerdown', event => {startedOutside = outside(event);});
  dialog.addEventListener('pointercancel', () => {startedOutside = false;});
  dialog.addEventListener('click', event => {
    const shouldDismiss = startedOutside && outside(event);
    startedOutside = false;
    if (shouldDismiss) dismiss();
  });
}
if (typeof module !== 'undefined') module.exports = {dismissOnBackdrop};
