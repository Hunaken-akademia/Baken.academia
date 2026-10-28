import { createRoot } from "react-dom/client";
import { RaceFinder } from "../components/race-finder";
createRoot(document.getElementById("root")!).render(<RaceFinder league="nar" onOpen={id => { document.getElementById("opened")!.textContent = id; }} />);
