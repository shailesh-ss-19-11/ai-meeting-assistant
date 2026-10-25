// Streams the Mac's system audio (what the speakers play, e.g. the other side of a Meet call) to stdout as
// raw 16 kHz mono signed 16-bit little-endian PCM, using a Core Audio process tap (macOS 14.2+).
import Foundation
import CoreAudio
import AudioToolbox

func fail(_ text: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data("capture failed: \(text)\n".utf8)); exit(code)
}
func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, as type: T.Type, default value: T) -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size); var result = value
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &result) == noErr else { fail("property \(selector)", 4) }
  return result
}

let debug = ProcessInfo.processInfo.environment["SYSAUDIO_DEBUG"] != nil
let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
description.uuid = UUID(); description.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
guard AudioHardwareCreateProcessTap(description, &tapID) == noErr else { fail("could not create the audio tap (allow audio recording for Electron in System Settings)", 2) }

let outputDevice = property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, as: AudioObjectID.self, default: 0)
var uidAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var uidRef: Unmanaged<CFString>?; var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
guard AudioObjectGetPropertyData(outputDevice, &uidAddress, 0, nil, &uidSize, &uidRef) == noErr, let outputUID = uidRef?.takeRetainedValue() as String? else { fail("no output device", 3) }

let aggregate: [String: Any] = [
  kAudioAggregateDeviceNameKey: "MeetingAssistantTap", kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID, kAudioAggregateDeviceIsPrivateKey: true, kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]]
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
guard AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID) == noErr else { fail("could not create the aggregate device", 5) }

let format = property(tapID, kAudioTapPropertyFormat, as: AudioStreamBasicDescription.self, default: AudioStreamBasicDescription())
let step = max(1.0, format.mSampleRate / 16000.0)
let channels = max(1, Int(format.mChannelsPerFrame))
var phase = 0.0, sum: Float = 0, count: Float = 0, callbacks = 0
if debug { FileHandle.standardError.write(Data("format rate=\(format.mSampleRate) channels=\(channels) flags=\(format.mFormatFlags)\n".utf8)) }

var procID: AudioDeviceIOProcID?
let queue = DispatchQueue(label: "audio-tap")
guard AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue, { _, input, _, _, _ in
  callbacks += 1
  let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
  var out = [Int16]()
  for buffer in buffers {
    guard let data = buffer.mData else { continue }
    let interleaved = Int(buffer.mNumberChannels)
    let samples = data.assumingMemoryBound(to: Float.self)
    let frames = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size / max(1, interleaved)
    for frame in 0..<frames {
      var mono: Float = 0
      for c in 0..<max(1, interleaved) { mono += samples[frame * max(1, interleaved) + c] }
      sum += mono / Float(max(1, interleaved)); count += 1; phase += 1
      if phase >= step { out.append(Int16(max(-1, min(1, sum / count)) * 32767)); sum = 0; count = 0; phase -= step }
    }
    break // tap delivers one interleaved buffer; extra buffers would duplicate channels
  }
  if debug && callbacks % 100 == 1 { FileHandle.standardError.write(Data("callbacks=\(callbacks) buffers=\(buffers.count) wrote=\(out.count)\n".utf8)) }
  if !out.isEmpty { out.withUnsafeBytes { FileHandle.standardOutput.write(Data($0)) } }
}) == noErr, let procID else { fail("could not create the IO proc", 6) }
guard AudioDeviceStart(aggregateID, procID) == noErr else { fail("could not start the audio device", 7) }
FileHandle.standardError.write(Data("capturing\n".utf8))
RunLoop.main.run()
