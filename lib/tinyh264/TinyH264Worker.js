import TinyH264Decoder from './TinyH264Decoder.js'
import TinyH264 from './TinyH264.js'

const h264Decoders = {}
const decodeStartedAt = {}

function init () {
  return TinyH264().then((tinyH264) => {
    self.addEventListener('message', (e) => {
      const message = e.data
      const renderStateId = message.renderStateId
      const messageType = message.type
      switch (messageType) {
        case 'decode': {
          let decoder = h264Decoders[renderStateId]
          if (!decoder) {
            decoder = new TinyH264Decoder(tinyH264, (output, width, height) => {
              const startedAt = decodeStartedAt[renderStateId] || 0
              const elapsedMs = startedAt > 0 ? (performance.now() - startedAt).toFixed(2) : 'n/a'
              console.info('[tinyh264] decode success', {
                renderStateId: renderStateId,
                width: width,
                height: height,
                elapsedMs: elapsedMs
              })
              postMessage({
                type: 'pictureReady',
                width: width,
                height: height,
                renderStateId: renderStateId,
                data: output.buffer
              }, [output.buffer])
            })
            h264Decoders[renderStateId] = decoder
          }
          decodeStartedAt[renderStateId] = performance.now()
          try {
            decoder.decode(new Uint8Array(message.data, message.offset, message.length))
          } catch (err) {
            console.error('[tinyh264] decode failed', {
              renderStateId: renderStateId,
              elapsedMs: (performance.now() - decodeStartedAt[renderStateId]).toFixed(2),
              message: err?.message || String(err)
            })
            throw err
          }
          break
        }
        case 'release': {
          const decoder = h264Decoders[renderStateId]
          if (decoder) {
            decoder.release()
            delete h264Decoders[renderStateId]
          }
          delete decodeStartedAt[renderStateId]
          break
        }
      }
    })

    self.postMessage({ 'type': 'decoderReady' })
  })
}

export {
  init
}
