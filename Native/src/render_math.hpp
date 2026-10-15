#pragma once
#include "openslope/math.hpp"

namespace openslope {
struct Matrix {
    std::array<float, 16> values{};

    static Matrix identity() {
        Matrix m;
        m.values[0] = m.values[5] = m.values[10] = m.values[15] = 1;
        return m;
    }

    Matrix operator*(const Matrix& b) const {
        Matrix m;
        for (unsigned c = 0; c < 4; ++c)
            for (unsigned r = 0; r < 4; ++r)
                for (unsigned k = 0; k < 4; ++k)
                    m.values[c * 4 + r] += values[k * 4 + r] * b.values[c * 4 + k];
        return m;
    }
};

inline Matrix projection(double left, double right, double down, double up, double near = .05, double far = 10000) {
    Matrix m;
    const auto width = right - left, height = down - up;
    m.values[0] = float(2 / width);
    m.values[5] = float(2 / height);
    m.values[8] = float((right + left) / width);
    m.values[9] = float((up + down) / height);
    // Reversed floating-point depth retains separation on distant layered facades.
    m.values[10] = float(near / (far - near));
    m.values[11] = -1;
    m.values[14] = float(far * near / (far - near));
    return m;
}

inline Matrix view(Vec3 eye, Vec3 forward, Vec3 up = {0, 1, 0}) {
    const auto f = normalized(forward, {0, 0, -1}), r = normalized(cross(f, up), {1, 0, 0}), u = cross(r, f);
    Matrix m = Matrix::identity();
    m.values[0] = float(r.x);
    m.values[4] = float(r.y);
    m.values[8] = float(r.z);
    m.values[1] = float(u.x);
    m.values[5] = float(u.y);
    m.values[9] = float(u.z);
    m.values[2] = float(-f.x);
    m.values[6] = float(-f.y);
    m.values[10] = float(-f.z);
    m.values[12] = float(-dot(r, eye));
    m.values[13] = float(-dot(u, eye));
    m.values[14] = float(dot(f, eye));
    return m;
}

inline Matrix board_transform(Vec3 position, Vec3 forward, Vec3 normal) {
    const auto right = normalized(cross(forward, normal)), up = normal, back = -forward;
    Matrix m = Matrix::identity();
    const std::array<Vec3, 3> axes{right, up, back};
    for (unsigned c = 0; c < 3; ++c) {
        m.values[c * 4] = float(axes[c].x);
        m.values[c * 4 + 1] = float(axes[c].y);
        m.values[c * 4 + 2] = float(axes[c].z);
    }
    m.values[12] = float(position.x + normal.x * .02);
    m.values[13] = float(position.y + normal.y * .02);
    m.values[14] = float(position.z + normal.z * .02);
    return m;
}
} // namespace openslope
