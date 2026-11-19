export default function Header() {
  return (
    <header className="flex items-center justify-center gap-3 pb-4 mb-6 border-b border-border">
      <img
        src="/icon.png"
        alt="Stremlist Logo"
        width={60}
        height={60}
        className="rounded"
      />
      <h1 className="text-3xl font-bold text-ink">Stremlist</h1>
    </header>
  );
}
