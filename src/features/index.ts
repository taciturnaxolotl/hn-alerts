import { commandSetup } from "./routing/commad";
import { setupHackerNewsMonitoring } from "./services/check_hn";

export default async function setup() {
  commandSetup();
  setupHackerNewsMonitoring();
}
