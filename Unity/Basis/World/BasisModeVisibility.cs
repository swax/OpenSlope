using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    // Basis hand-off for authored mode presence. There is no Basis settings board yet, but the bitset survives the
    // neutral import and can be driven by any local mode selector (0 race / 1 show-off / 2 freeride).
    public class BasisModeVisibility : MonoBehaviour
    {
        public int ModeMask = 7;

        public void SetMode(int mode)
        {
            int bit = mode == 0 ? 1 : mode == 1 ? 2 : 4;
            gameObject.SetActive((ModeMask & bit) != 0);
        }
    }
}
