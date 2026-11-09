import { useMemo } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router";
import { Analytics } from "@vercel/analytics/react";
import { Toaster } from "sonner";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import Home from "./pages/Home";
import Terms from "./pages/Terms";
import Changelog from "./pages/Changelog";
import Configure from "./pages/Configure";
import ConnectReturn from "./pages/ConnectReturn";
import NotFound from "./pages/NotFound";
import { parseConnectAnswer } from "./lib/connections";

/**
 * The configure page, or the completion of a connect when the backend
 * callback brings the Provider's answer in the fragment.
 */
function ConfigureRoute() {
  const { hash } = useLocation();
  const answer = useMemo(() => parseConnectAnswer(hash), [hash]);
  return answer ? <ConnectReturn answer={answer} /> : <Configure />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/configure" element={<ConfigureRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster
        position="bottom-left"
        closeButton
        duration={6000}
        icons={{
          success: <CircleCheck className="size-4 text-emerald-600" />,
          error: <CircleX className="size-4 text-red-600" />,
          info: <Info className="size-4 text-blue-600" />,
          warning: <TriangleAlert className="size-4 text-amber-600" />,
        }}
        toastOptions={{
          style: {
            fontFamily: "var(--font-rounded)",
            borderRadius: "var(--radius-xl)",
          },
        }}
      />
      <Analytics />
    </BrowserRouter>
  );
}
