import { BackgroundCanvas } from "@/features/canvas/components/background-canvas";
import { MobileLaneList } from "@/features/canvas/components/mobile-lane-list";
import { NotificationFocus } from "@/features/notifications/notification-focus";

export default function Home() {
  return (
    <main className="relative h-full w-full overflow-hidden bg-[#0a0a0a] text-white">
      <NotificationFocus />

      <div
        className="relative z-10 hidden h-full w-full md:block"
        data-testid="desktop-canvas"
      >
        <BackgroundCanvas />
      </div>

      <div
        className="h-full w-full pt-16 md:hidden"
        data-testid="mobile-lane-list"
      >
        <MobileLaneList />
      </div>
    </main>
  );
}
