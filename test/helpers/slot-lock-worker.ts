import {
  buildManifest,
  loadSlotState,
  persistSlotState,
  withSlotStateLock,
} from '../../src/manifest-store'

const [dataDir, playlistId, prefix, count] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
]

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function main() {
  for (let index = 0; index < Number(count); index++) {
    await withSlotStateLock(dataDir, playlistId, () => {
      const previous = loadSlotState(dataDir, playlistId)
      sleepSync(3)
      const entries = [
        ...Object.keys(previous?.videoIdToSlot ?? {}),
        `${prefix}${index}`,
      ].map((id) => ({ id, title: null, duration: null }))
      const { state } = buildManifest(
        previous,
        playlistId,
        1000,
        entries,
        Date.now()
      )
      persistSlotState(dataDir, state)
    })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
