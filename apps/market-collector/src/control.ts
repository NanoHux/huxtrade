export function scanningPaused(globalState:Record<string,unknown>|undefined,riskState:Record<string,unknown>|undefined){
  return Boolean(globalState?.paused)||Boolean(riskState?.autoPaused);
}
