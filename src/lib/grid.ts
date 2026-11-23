// Lưới, khe và bo góc CHUNG của các trang thẻ (Tổng quan, Dự án, các phase),
// theo cùng ý của lib/home-grid.ts bên VNLab Home: mọi hàng thẻ dựng trên cùng
// một hệ cột và cùng khe, nên mép thẻ của các hàng trùng nhau.
// Để chuỗi class nguyên văn ở đây để Tailwind quét được.

/** Khe giữa các ô — giống hệt nhau ở mọi lưới thẻ. */
export const GRID_GAP = 'gap-2 sm:gap-2.5 md:gap-3';

/** Lưới thẻ dự án / phase: 1 cột điện thoại, 2 cột từ sm, 3 cột desktop rộng. */
export const GRID_CARDS = 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';

/** Lưới thẻ trong cột hẹp (Tổng quan: cột trái 1.4fr): tối đa 2 cột. */
export const GRID_CARDS_NARROW = 'grid-cols-1 sm:grid-cols-2';

// Bo góc theo CHIỀU CAO thẻ, không theo loại thẻ (như VNLab Home):
//   • Thẻ thấp (thẻ dự án, thẻ phase ~120–150px) → 20px.
//   • Khối cao (danh sách nhóm, bảng Gantt, lịch) → 24–28px.
// Các ô đứng cạnh nhau trong cùng một hàng dùng cùng một bán kính.

/** Thẻ thấp: thẻ dự án, thẻ phase, ô "Thêm …". */
export const RADIUS_SHORT = 'rounded-[20px]';

/** Khối cao: danh sách nhóm (Cài đặt, việc sắp tới), thẻ trống. */
export const RADIUS_TALL = 'rounded-2xl';

/** Mặt thẻ chung: cùng màu, độ mờ, viền mờ và bóng nhẹ (xem .surface-card trong index.css). */
export const SURFACE = 'surface-card';

/** Vòng icon 44px đầu thẻ (như thẻ thiết bị / lịch trình bên VNLab Home). */
export const ICON_CIRCLE = 'grid size-11 shrink-0 place-items-center rounded-full';
