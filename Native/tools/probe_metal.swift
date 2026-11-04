// Exit 77 only when the host cannot provide resources required by MoltenVK.
import Darwin
import Metal

guard let device = MTLCreateSystemDefaultDevice() else {
    print("Metal device unavailable")
    exit(77)
}

for length in [4, 80, 4096] {
    let requirement = device.heapBufferSizeAndAlign(length: length, options: .storageModePrivate)
    print("Metal resource probe: \(device.name), bytes \(length), heap size \(requirement.size), alignment \(requirement.align)")
    if requirement.size < length || requirement.align == 0 {
        print("Metal placement-heap requirements unavailable")
        exit(77)
    }
    guard device.makeBuffer(length: length, options: .storageModeShared) != nil else {
        print("Metal shared-buffer allocation unavailable")
        exit(77)
    }
}
