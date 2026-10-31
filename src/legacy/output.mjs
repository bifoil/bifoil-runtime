// Publish completed native paragraphs before engine-owned image/chart rendering.
// Empty native returns must not split an enclosing Bifoil prose paragraph.
export function publishOutput(call) {
  if (call.host.publishOutput && call.output.length) call.host.publishOutput(call.output.splice(0));
}

export function installOutput(scene, call) {
  if (!call.host.publishOutput) return;
  for (const name of ["image", "stat_chart"]) {
    const render = call.host.Scene.prototype[name];
    if (typeof render !== "function") continue;
    scene[name] = (...arguments_) => {
      // These commands render even when no native paragraph preceded them.
      call.host.publishOutput([]);
      return render.apply(scene, arguments_);
    };
  }
  const lineBreak = call.host.Scene.prototype.line_break;
  if (typeof lineBreak === "function") {
    scene.line_break = (...arguments_) => {
      // With buffered native text, the engine appends its inline break marker.
      // With an empty buffer it renders directly and needs prior VM output first.
      if (!scene.accumulatedParagraph.length) call.host.publishOutput([]);
      return lineBreak.apply(scene, arguments_);
    };
  }
}
