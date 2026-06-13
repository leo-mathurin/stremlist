export default function ServiceBanner() {
  return (
    <div
      role="alert"
      className="w-full bg-amber-50 border-b border-amber-200 px-4 py-3 text-center text-sm text-amber-900"
    >
      <p className="max-w-3xl mx-auto">
        <strong>⚠️ Stremlist is temporarily down.</strong> We've hit our
        database usage limit, so the addon won't work until it resets on{" "}
        <strong>June 16</strong>. Thanks for your patience. If you'd like to
        help keep Stremlist running, you can{" "}
        <a
          href="https://ko-fi.com/lelemathrin"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-stremlist underline underline-offset-2"
        >
          buy me a coffee ❤️
        </a>
        .
      </p>
    </div>
  );
}
