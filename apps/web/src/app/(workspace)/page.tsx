import { BackgroundCanvas } from "@/features/canvas/components/background-canvas";
import { MobileLaneList } from "@/features/canvas/components/mobile-lane-list";

/**
 * Canvas on desktop, lane list on phones (spec §9).
 *
 * Both are mounted and toggled with responsive visibility rather than chosen by a
 * media query in an effect. A media query read in JS would need a client-only
 * first paint and would flash the wrong layout on load; CSS decides before paint.
 *
 * `md` is the switch: the canvas needs a pointer and room for freeform layout,
 * which is exactly what a phone does not have.
 */
export default function Home() {
  return (
    <main className="relative h-full w-full overflow-hidden bg-[#0a0a0a] text-white">
      {/* The `data-testid`s name which layout owns the viewport, so a phone
          assertion is about the layout switch rather than about whether React
          Flow happened to lay a node out yet. */}
      <div
        className="relative z-10 hidden h-full w-full md:block"
        data-testid="desktop-canvas"
      >
        <BackgroundCanvas />
      </div>
      <div className="h-full w-full md:hidden" data-testid="mobile-lane-list">
        <MobileLaneList />
      </div>
    </main>
  );
}
