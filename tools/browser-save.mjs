// The acceptance host owns rendered page history separately from VM execution.
// Reattach validated execution before restoring presentation and rebuilding controls.
const FORMAT = "bifoil.browser-save.v1";

export function savePresentation(checkpoint, parent) {
  const page = parent.cloneNode(true);
  for (const control of page.querySelectorAll("form, button, input, select, textarea")) control.remove();
  return JSON.stringify({ format: FORMAT, checkpoint, presentation: page.innerHTML });
}

export function readPresentation(saved) {
  const data = JSON.parse(saved);
  // Earlier acceptance-host saves stored the VM checkpoint directly.
  if (data?.format !== FORMAT) return { checkpoint: saved, presentation: null };
  if (typeof data.checkpoint !== "string" || typeof data.presentation !== "string")
    throw new Error("Invalid browser checkpoint");
  return data;
}
