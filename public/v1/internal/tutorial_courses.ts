type User = Record<string, unknown>;
export const OPTIONAL_TUTORIAL_COURSES = ["software-update-refresh", "full-house-drawing"] as const;
export function assignedTutorialCourses(user: User) {
  const values = Array.isArray(user.assigned_tutorial_course_ids)
    ? user.assigned_tutorial_course_ids : [user.assigned_tutorial_course_id];
  return [...new Set(values.map(value => String(value ?? "").trim().toLowerCase())
    .filter(value => OPTIONAL_TUTORIAL_COURSES.includes(value as typeof OPTIONAL_TUTORIAL_COURSES[number])))];
}
export function hasTutorialCourse(user: User, courseId: string) {
  return courseId === "default" || assignedTutorialCourses(user).includes(courseId);
}
