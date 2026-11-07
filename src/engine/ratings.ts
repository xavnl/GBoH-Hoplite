/** Wounded leaders have all ratings reduced by 2, minimum 0 (8.33). */
export const effRating = (v: number, wounded: boolean) => (wounded ? Math.max(0, v - 2) : v);
