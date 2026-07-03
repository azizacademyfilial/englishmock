# Admin Level Unlock Feature - Complete Implementation Guide

## Overview
This document explains how the English Mock application allows administrators to unlock specific English proficiency levels (Beginner, Elementary, Pre-Intermediate, Intermediate) for students, allowing them to access and complete tests in those levels without first passing the prerequisite tests.

---

## Current System Architecture

### Level Structure
The application organizes English learning into **4 levels**:
1. **Beginner** (default level - always accessible)
2. **Elementary** 
3. **Pre-Intermediate**
4. **Intermediate**

### How Level Access Works

#### Student Perspective
Students can access a level if ANY of these conditions are TRUE:
1. **It's the Beginner level** (always available)
2. **Admin has explicitly unlocked it** (using `unlockedLevels`)
3. **Student passed the Gate Test** for that level (score ≥ 70%)
4. **Student passed the Final Test** of the previous level (score ≥ 70%)

#### Technical Implementation
The backend function `hasLevelAccess()` at line 20374 implements this logic:

```javascript
function hasLevelAccess(db, userId, language, level) {
  if (level === FIRST_LEVEL) return true;  // Beginner always accessible
  const user = db.users.find(u => u.id === userId);
  if (hasAdminLevelUnlock(user, level)) return true;  // Admin unlock
  const p = userProgress(db, userId);
  const previous = levels[levelIndex[level] - 1];
  // Check if passed gate test OR previous level's final test
  return (p[gateKey(language, level)]?.bestScore || 0) >= LEVEL_PASS_SCORE || 
         (p[finalKey(language, previous)]?.bestScore || 0) >= LEVEL_PASS_SCORE;
}
```

---

## Database Schema

### User Record Fields (Relevant to Level Unlocking)

```json
{
  "id": "student_123",
  "username": "ahmed_student",
  "fullName": "Ahmed Abdullah",
  "role": "student",
  "subject": "english",
  "unlockedLevels": ["Elementary", "Pre-Intermediate"],  // Admin-unlocked levels
  "currentLevel": "Elementary",  // Current working level
  "center": "center_1",
  "planDays": 30,
  "allowUnlimitedTopics": false,
  "createdAt": "2024-01-15T10:30:00Z",
  "lastLoginAt": "2024-06-20T08:15:00Z"
}
```

### Unlocked Levels Array
- **Field Name**: `unlockedLevels`
- **Data Type**: Array of strings
- **Valid Values**: `["Elementary", "Pre-Intermediate", "Intermediate"]`
- **Note**: Beginner is always accessible and doesn't need to be listed
- **Function**: `normalizeUnlockedLevels()` ensures data consistency

---

## Admin Interface - How to Unlock Levels

### Method 1: Bulk Update (Recommended for Multiple Students)

**Endpoint**: `PATCH /api/admin/users/plan-days/bulk`

**What It Does**:
- Update plan days AND/OR unlocked levels for multiple students at once
- Add new levels to existing unlocked levels (doesn't replace them)

**Request Body**:
```json
{
  "userIds": ["student_1", "student_2", "student_3"],
  "planDays": [30, 60],              // Optional: plan days to add
  "unlockedLevels": ["Elementary", "Pre-Intermediate"],  // Levels to unlock
  "topicAccessMode": "",             // Optional: "unlimited" or ""
  "allowUnlimitedTopics": false      // Optional: boolean
}
```

**Example Request**:
```bash
curl -X PATCH http://localhost:5000/api/admin/users/plan-days/bulk \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "userIds": ["user_123", "user_456"],
    "unlockedLevels": ["Pre-Intermediate"]
  }'
```

**Response**:
```json
{
  "message": "2 ta o'quvchiga Pre-Intermediate darajalari ochildi",
  "users": [
    { "id": "user_123", "unlockedLevels": ["Elementary", "Pre-Intermediate"], ... },
    { "id": "user_456", "unlockedLevels": ["Elementary", "Pre-Intermediate"], ... }
  ],
  "planDays": [],
  "unlockedLevels": ["Pre-Intermediate"],
  "allowUnlimitedTopics": false,
  "topicAccessMode": ""
}
```

### Method 2: Individual Student Update

**Endpoint**: `PATCH /api/admin/users/:id`

**What It Does**:
- Update a single student's profile
- Can set `unlockedLevels` to a specific array (replaces existing)

**Request Body**:
```json
{
  "unlockedLevels": ["Elementary", "Pre-Intermediate", "Intermediate"]
}
```

**Example Request**:
```bash
curl -X PATCH http://localhost:5000/api/admin/users/student_123 \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "unlockedLevels": ["Elementary", "Pre-Intermediate"]
  }'
```

**Response**:
```json
{
  "id": "student_123",
  "username": "ahmed_student",
  "fullName": "Ahmed Abdullah",
  "unlockedLevels": ["Elementary", "Pre-Intermediate"],
  "currentLevel": "Elementary",
  ...
}
```

---

## Frontend Interface - Student View

### What Students See

#### Level Selection Screen
Students see levels displayed with their access status:

```
📚 English Levels
├─ ✓ Beginner (Ochiq)           [Open - Always accessible]
├─ ✓ Elementary (Ochiq)         [Open - Admin unlocked OR passed previous test]
├─ 🔒 Pre-Intermediate (Test kerak)   [Locked - Admin must unlock OR pass Elementary final]
└─ 🔒 Intermediate (Test kerak)      [Locked - Admin must unlock OR pass Pre-Intermediate final]
```

#### Access Indicators
- **✓ Ochiq** (Open): Student can access this level
- **🔒 Locked**: Student cannot access (either locked by admin or prerequisites not met)
- **· Ishlanmoqda**: Level is still being prepared

### Frontend Code References
```javascript
// File: frontend/src/main.jsx

// Line 6242: Level pill display with lock icon
className={`levelPill ${level === lv ? 'active' : ''} ${
  progress.access[subject]?.[lv] ? 'open' : 'locked'
}`}

// Line 6247: Access status message
{progress.access[subject]?.[lv] ? '✓' : '🔒'}

// Line 2275: Admin panel showing unlocked levels
{['Beginner', ...(user.unlockedLevels || [])].map(lv => 
  <span className="planDayBadge levelBadge">{lv}</span>
)}
```

---

## Step-by-Step Admin Instructions

### Scenario 1: Open Pre-Intermediate for a Single Student

1. **Navigate to Admin Dashboard**
   - Login as admin
   - Go to "O'quvchilar" (Students) section

2. **Find the Student**
   - Search for student by name or username
   - Click on the student's row

3. **Update Level Access**
   - Find "Daraja" (Level) field
   - Current: `Beginner`
   - Update to unlock Pre-Intermediate:
     ```
     unlockedLevels: ["Elementary", "Pre-Intermediate"]
     ```
   - Click "Saqlash" (Save)

4. **Verify**
   - Refresh the student's progress page
   - Student can now see Pre-Intermediate level as "Ochiq" (Open)

### Scenario 2: Open Multiple Levels for Multiple Students

1. **Select Multiple Students**
   - In Students list, check boxes for students
   - Use "Tanlash" (Select) option

2. **Bulk Update**
   - Click "Darajalarni ochish" (Unlock Levels) button
   - Select levels: Pre-Intermediate, Intermediate
   - Click "Yubor" (Send)

3. **System Response**
   - System confirms: "3 ta o'quvchiga Pre-Intermediate, Intermediate darajalari ochildi"
   - All selected students now have access

### Scenario 3: Remove Level Access

1. **Edit Student**
   - Open student profile
   - Set `unlockedLevels` to empty array or remove the level
   
   **Example**: 
   - Current: `["Elementary", "Pre-Intermediate"]`
   - New: `["Elementary"]` (removes Pre-Intermediate access)

2. **Save**
   - Click Save
   - Student can no longer access Pre-Intermediate unless they pass Elementary final test

---

## Business Logic & Rules

### Important Rules

1. **Beginner is Always Accessible**
   - First level cannot be locked
   - No need to add to `unlockedLevels`

2. **Unlocked Levels Persist**
   - Admin unlock is permanent (until admin removes it)
   - Doesn't expire or reset
   - Combines with progress-based access

3. **Natural Progression Still Works**
   - Even if admin unlocks a level, students still see topics as locked until they pass prerequisites
   - Admin unlock gives access to the LEVEL, not individual topics

4. **No Forced Ordering**
   - Admin can unlock any level in any order
   - Student with Beginner + Pre-Intermediate unlocked can practice either
   - Can skip Elementary entirely if admin allows

### Validation

The system validates:
```javascript
// Only valid levels can be unlocked
const validLevels = ['Elementary', 'Pre-Intermediate', 'Intermediate'];
if (!unlockedLevels.every(lv => validLevels.includes(lv))) {
  return error('Noto'g'ri daraja');
}

// No duplicates
unlockedLevels = [...new Set(unlockedLevels)];
```

---

## Database Queries & Operations

### Finding Students with Specific Unlock Status

```sql
-- Find students with Pre-Intermediate unlocked
SELECT * FROM app_users 
WHERE role = 'student' 
  AND data->>'unlockedLevels' LIKE '%Pre-Intermediate%'

-- Find students with NO level unlocks
SELECT * FROM app_users 
WHERE role = 'student' 
  AND (data->>'unlockedLevels' = '[]' OR data->>'unlockedLevels' IS NULL)
```

### Backup & Recovery

When backup is created (daily or manual):
```
Location: /admin/backups/db_backup_2024-06-20.json
Contains: All user records with unlockedLevels data
```

---

## Monitoring & Troubleshooting

### Admin Dashboard Indicators

**Weak Students Panel**: Shows students needing attention
- Filters by current level
- Shows progress percentage
- Admin can click to adjust level access

**Reports Section**: 
- Lists all students by level
- Shows current progress
- Allows filtering by center/group

### Common Issues & Solutions

**Issue 1**: Student says they can't access unlocked level
- **Solution**: Check that level is in `unlockedLevels` array
- **Verify**: Ask admin to click student row and confirm level is listed

**Issue 2**: Level appears locked even after unlock
- **Solution**: Student needs to refresh page (Ctrl+R or cmd+R)
- **Verify**: Check that save request returned success

**Issue 3**: Multiple students, only some got access
- **Solution**: Verify bulk request included correct `userIds`
- **Verify**: Check response message lists correct number of students

---

## API Response Structure

### Access Object Format
When student requests `/api/progress`:
```json
{
  "progress": { /* topic progress data */ },
  "access": {
    "english": {
      "Beginner": true,           // Always true
      "Elementary": true,         // Admin unlocked OR passed test
      "Pre-Intermediate": false,  // Not unlocked AND didn't pass test
      "Intermediate": false       // Not unlocked AND didn't pass test
    }
  },
  "speakingSummary": { /* speaking stats */ },
  "certificates": [ /* earned certificates */ ]
}
```

### How Frontend Uses It
```javascript
// frontend/src/main.jsx line 5289
const levelAccess = progress.access?.[subject] || {};

// Display level as locked or open
const isOpen = levelAccess['Pre-Intermediate'];  // true/false

// Show appropriate UI
className={isOpen ? 'open' : 'locked'}
```

---

## Practical Use Cases

### Case 1: Speed-Up Fast Learners
**Scenario**: Mohammad finishes Beginner in 2 weeks instead of planned 4 weeks
**Solution**: Admin unlocks Elementary immediately
**Code**: 
```bash
PATCH /api/admin/users/mohammad_123
Body: {"unlockedLevels": ["Elementary"]}
```

### Case 2: Group Promotion
**Scenario**: End of semester, promote 25 students to Pre-Intermediate
**Solution**: Bulk unlock
```bash
PATCH /api/admin/users/plan-days/bulk
Body: {
  "userIds": [user_1, user_2, ..., user_25],
  "unlockedLevels": ["Pre-Intermediate"]
}
```

### Case 3: Advanced Student Track
**Scenario**: Ali wants to skip Elementary and start Pre-Intermediate
**Solution**: Admin unlocks both Elementary and Pre-Intermediate
```bash
PATCH /api/admin/users/ali_123
Body: {"unlockedLevels": ["Elementary", "Pre-Intermediate"]}
```

### Case 4: Summer Intensive Program
**Scenario**: 40 students in intensive, each should have all levels
**Solution**: Bulk unlock everything
```bash
PATCH /api/admin/users/plan-days/bulk
Body: {
  "userIds": [all 40 student IDs],
  "unlockedLevels": ["Elementary", "Pre-Intermediate", "Intermediate"]
}
```

---

## Technical Reference

### Key Functions (Backend)

| Function | Location | Purpose |
|----------|----------|---------|
| `hasAdminLevelUnlock()` | Line 1685 | Checks if level is in student's unlockedLevels |
| `hasLevelAccess()` | Line 20374 | Determines if student can access level |
| `isTopicUnlocked()` | Line 20383 | Checks if specific topic is accessible |
| `normalizeUnlockedLevels()` | Line 1699 | Cleans and validates level array |
| `/api/progress` | Line 20893 | Returns access object with all level statuses |
| `/api/admin/users/:id` | Line 21461 | Update individual user (PATCH) |
| `/api/admin/users/plan-days/bulk` | Line 21395 | Bulk update multiple users |

### Frontend Components
- **Level Selection**: main.jsx lines 5368, 5636, 6242
- **Access Indicator**: main.jsx line 6247
- **Admin Form**: main.jsx line 1457 (bulk update)

---

## Security Considerations

### Access Control
- Only users with `role: 'admin'` can modify `unlockedLevels`
- Authentication required (`auth` middleware)
- Rate limiting on admin endpoints

### Data Validation
```javascript
// Validate user is actually admin
if (req.user.role !== 'admin') return res.status(403).json({message: 'Forbidden'});

// Validate levels are legitimate
const validLevels = ['Elementary', 'Pre-Intermediate', 'Intermediate'];
unlockedLevels = unlockedLevels.filter(lv => validLevels.includes(lv));

// Prevent duplicates
unlockedLevels = [...new Set(unlockedLevels)];
```

### Audit Logging
All admin changes are logged:
```javascript
addActionLog(db, req.user, 'plan_days_or_levels_assigned', 'students', {
  userIds: updatedUsers.map(u => u.id),
  unlockedLevels: selectedPlanLevels
}, req);
```

---

## Summary

The English Mock application has **full support** for admin-controlled level unlocking:

✅ **What Works**:
- Admins can unlock specific levels for any student
- Bulk unlocking for multiple students
- Individual student profile updates
- Persistent unlock status
- Combines with natural progression

✅ **How It Works**:
- Stored in user's `unlockedLevels` array
- Checked by `hasAdminLevelUnlock()` function
- Displayed in student's level access status
- Non-destructive (can be removed or modified)

✅ **How Admins Use It**:
- Via `/api/admin/users/:id` for individual updates
- Via `/api/admin/users/plan-days/bulk` for group updates
- Via admin dashboard UI (if implemented in your version)

✅ **Student Experience**:
- See unlocked levels as "Ochiq" (Open)
- Can practice and take tests immediately
- Same as if they had passed prerequisites

---

## Next Steps

1. **Verify Admin Access**: Ensure your admin account has proper permissions
2. **Test Single Update**: Update one student and verify they can access unlocked level
3. **Test Bulk Update**: Unlock level for group of students
4. **Monitor Progress**: Track students' usage of unlocked levels
5. **Adjust as Needed**: Add/remove levels based on student performance

---

## Support

For issues or questions:
1. Check if student has refreshed their page
2. Verify level name matches exactly: "Elementary", "Pre-Intermediate", "Intermediate"
3. Check admin has proper role: `role: 'admin'`
4. Review action logs to see what was actually saved
5. Check system logs for any errors during update
