import { createRoot } from "react-dom/client";
import RaceDashboard from "../components/race-dashboard";

// Standalone browser QA with synthetic responses. Never served as an application route.
const area = new URLSearchParams(location.search).get("area") === "nar" ? "nar" : "jra";
createRoot(document.getElementById("root")!).render(<RaceDashboard area={area} />);
