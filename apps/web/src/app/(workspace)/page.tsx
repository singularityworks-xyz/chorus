import { BackgroundCanvas } from "@/features/canvas/components/background-canvas";

export default function Home() {
  return (
    <main className="relative h-full w-full overflow-hidden bg-[#0a0a0a] text-white">
      <div className="relative z-10 h-full w-full">
        <BackgroundCanvas />
      </div>
    </main>
  );
}
