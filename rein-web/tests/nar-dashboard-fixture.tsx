import { createRoot } from "react-dom/client";
import RaceDashboard from "../components/race-dashboard";

// Browser QA only, never exposed as a production route.
createRoot(document.getElementById("root")!).render(<>
  <p className="p-3 text-center text-amber-200">表示検証専用・公開予測ではありません</p>
  <RaceDashboard area="nar" />
</>);
