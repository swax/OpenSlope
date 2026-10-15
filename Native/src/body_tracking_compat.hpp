#pragma once
#include <openxr/openxr.h>

// Public revision-1 ABI absent from the pinned 1.1.53 headers. Khronos definitions:
// https://registry.khronos.org/OpenXR/specs/1.1/man/html/XR_META_body_tracking_fidelity.html
#ifndef XR_META_body_tracking_fidelity
#define XR_META_body_tracking_fidelity 1
#define XR_META_BODY_TRACKING_FIDELITY_EXTENSION_NAME "XR_META_body_tracking_fidelity"
inline constexpr XrStructureType XR_TYPE_BODY_TRACKING_FIDELITY_STATUS_META = static_cast<XrStructureType>(1000284000);
inline constexpr XrStructureType XR_TYPE_SYSTEM_PROPERTIES_BODY_TRACKING_FIDELITY_META =
    static_cast<XrStructureType>(1000284001);

enum XrBodyTrackingFidelityMETA {
    XR_BODY_TRACKING_FIDELITY_LOW_META = 1,
    XR_BODY_TRACKING_FIDELITY_HIGH_META = 2,
    XR_BODY_TRACKING_FIDELITY_MAX_ENUM_META = 0x7fffffff
};

struct XrSystemPropertiesBodyTrackingFidelityMETA {
    XrStructureType type;
    void* next;
    XrBool32 supportsBodyTrackingFidelity;
};

struct XrBodyTrackingFidelityStatusMETA {
    XrStructureType type;
    void* next;
    XrBodyTrackingFidelityMETA fidelity;
};

using PFN_xrRequestBodyTrackingFidelityMETA = XrResult(XRAPI_PTR*)(XrBodyTrackerFB, const XrBodyTrackingFidelityMETA);
#endif
