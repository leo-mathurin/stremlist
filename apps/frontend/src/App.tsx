import { useMemo } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
  RouterProvider,
  useLocation,
} from "react-router";
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

function ConfigureRoute() {
  const { hash } = useLocation();
  const answer = useMemo(() => parseConnectAnswer(hash), [hash]);
  if (answer) return <ConnectReturn answer={answer} />;
  return <Configure />;
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<Home />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/changelog" element={<Changelog />} />
      <Route path="/configure" element={<ConfigureRoute />} />
      <Route path="*" element={<NotFound />} />
    </>,
  ),
);

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <Toaster
        position="bottom-left"
        closeButton
        duration={6000}
        icons={{
          success: <CircleCheck className="size-4 text-success-600" />,
          error: <CircleX className="size-4 text-danger-600" />,
          info: <Info className="size-4 text-stremlist" />,
          warning: <TriangleAlert className="size-4 text-warning-600" />,
        }}
        toastOptions={{
          style: {
            fontFamily: "var(--font-rounded)",
            borderRadius: "var(--radius-xl)",
          },
        }}
      />
      <Analytics
        beforeSend={(event) => ({ ...event, url: event.url.split(/[?#]/)[0] })}
      />
    </>
  );
}
