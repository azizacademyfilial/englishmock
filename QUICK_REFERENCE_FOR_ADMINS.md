# Admin Level Unlock - Quick Reference Card

## 🎯 What Can You Do?

Unlock English proficiency levels (Elementary, Pre-Intermediate, Intermediate) for any student so they can practice and test at those levels immediately without passing prerequisites.

---

## 📱 How to Unlock Levels

### Option A: Using Admin Dashboard (Recommended - Easiest)

1. **Login as Admin**
   - Go to admin panel
   - Enter your admin credentials

2. **Find Student**
   - Click "O'quvchilar" (Students)
   - Search for student by name or username
   - Click on the student row

3. **Unlock Level**
   - Find "Darajalar" (Levels) field
   - See list of currently unlocked levels
   - Click "+" or "Daraja Qo'shish" (Add Level)
   - Select: Elementary, Pre-Intermediate, or Intermediate
   - Click "Saqlash" (Save)

4. **Verify**
   - Student refreshes their page
   - Should now see unlocked level as "✓ Ochiq" (Open)

### Option B: Bulk Unlock for Multiple Students

1. **Select Students**
   - In student list, check boxes for multiple students
   - Or use "Barchasini Tanlash" (Select All)

2. **Bulk Action**
   - Click "Darajalarni Ochish" (Unlock Levels) button
   - Choose which levels: ☐ Elementary ☐ Pre-Intermediate ☐ Intermediate
   - Click "Yubor" (Send)

3. **Confirmation**
   - System shows: "X ta o'quvchiga [levels] darajalari ochildi"
   - All selected students now have access

### Option C: Using API (For Developers)

**Single Student**:
```bash
curl -X PATCH http://localhost:5000/api/admin/users/STUDENT_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"unlockedLevels": ["Elementary", "Pre-Intermediate"]}'
```

**Multiple Students**:
```bash
curl -X PATCH http://localhost:5000/api/admin/users/plan-days/bulk \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userIds": ["student_1", "student_2"],
    "unlockedLevels": ["Pre-Intermediate"]
  }'
```

---

## 📋 Level Reference

| Level | When Student Gets It Automatically | What It Teaches |
|-------|-------------------------------------|-----------------|
| **Beginner** | Always (no unlock needed) | Basic grammar: am/is/are, simple present, basic vocabulary |
| **Elementary** | After passing Beginner final test (70%+) OR admin unlock | Present continuous, past simple, basic questions |
| **Pre-Intermediate** | After passing Elementary final test (70%+) OR admin unlock | Present perfect, more complex tenses, phrasal verbs |
| **Intermediate** | After passing Pre-Intermediate final test (70%+) OR admin unlock | Advanced tenses, conditional sentences, complex structures |

---

## ✅ What Happens After You Unlock?

### Student Sees:
- Level shows as "✓ Ochiq" (Open) with checkmark
- Can select level from menu
- Can practice all topics in that level
- Can take the final test for that level

### You Can Still:
- Remove the unlock anytime
- Student keeps their progress (won't be deleted)
- Later they can also earn access naturally by passing tests

### Student Cannot:
- Skip topics (must do them in order)
- Take test before completing topics
- Move to next level until they pass final test

---

## 🔄 Common Scenarios

### Scenario 1: "I unlocked it, but student can't see it"
**Solution**: Ask student to refresh page (Ctrl+R or Cmd+R)

### Scenario 2: "I want to remove access"
**How**: Edit student → Remove level from list → Save

### Scenario 3: "Student says test is locked despite unlock"
**Why**: They need to complete prerequisite topics first
**Solution**: Check that topics are completed, or unlock earlier level

### Scenario 4: "Promote whole class to next level"
**How**: 
1. Select all students in the class
2. Click "Darajalarni Ochish" (Unlock Levels)
3. Choose next level
4. Click "Yubor" (Send)
5. Done! ✓

### Scenario 5: "Create accelerated track"
**How**: Unlock all levels for advanced students
1. Find fast learner
2. Set `unlockedLevels`: [Elementary, Pre-Intermediate, Intermediate]
3. They can practice at any level they want

---

## 🚫 What You CANNOT Do

- ❌ Lock Beginner level (always accessible)
- ❌ Erase student's progress by unlocking
- ❌ Force students to do topics out of order
- ❌ Skip the final test requirement for level completion
- ❌ Let one student access another student's account

---

## 📊 Check Unlock Status

### Via Admin Dashboard:
- Go to Students list
- Look at each student row
- See "Darajalar" or "Levels" column
- Shows: Beginner, Elementary, Pre-Intermediate, Intermediate

### Via Reports:
- Click "Hisobot" (Reports)
- View all students by their current level
- See progress percentage

### Via Action Log:
- Click "Tarixcha" (History) → "Harakatchannomi" (Action Logs)
- Filter for "level" changes
- See when/who unlocked what for whom

---

## ⚡ Quick Tips

💡 **Tip 1**: Bulk unlock is fastest for groups
- 1 student: Use individual edit
- 5+ students: Use bulk unlock button

💡 **Tip 2**: Levels don't expire
- Once unlocked, stays unlocked (unless you remove it)
- Permanent until you change it

💡 **Tip 3**: Combine with other features
- Unlock level + Give plan days = Full semester setup
- Unlock level + Allow unlimited topics = Complete access

💡 **Tip 4**: Use for summer courses
- Unlock all levels for intensive programs
- Students can study any level they want
- No waiting for test results

💡 **Tip 5**: Progressive unlock
- Week 1: Unlock Elementary
- Week 3: Unlock Pre-Intermediate
- Week 5: Unlock Intermediate
- Keep them engaged without overwhelming

---

## 🎓 Teaching Tips

### Use Level Unlock For:

✅ **Speed-up Fast Learners**
- Finished unit early? Unlock next level
- Keep them engaged

✅ **Remedial Students**
- Struggling with current level?
- Let them try earlier level for review
- Unlock when confident

✅ **Flexible Programs**
- Self-paced courses
- Blended learning
- Summer intensives

✅ **Assessment Freedom**
- Student wants to challenge themselves?
- Unlock and let them try

### Don't Use For:

❌ As punishment (locking levels)
❌ As reward (only way to progress) - tests work better
❌ To skip content entirely (they still need topics)
❌ For lazy admin work (understanding each student is better)

---

## 🆘 Troubleshooting Checklist

| Problem | Solution |
|---------|----------|
| "I can't find unlock button" | Check you're logged in as admin, find student's row, click edit |
| "Level won't save" | Check spelling of level name (Elementary, Pre-Intermediate, Intermediate) |
| "Student still says locked" | Student needs to refresh page (Ctrl+R) |
| "Bulk unlock didn't work" | Verify student IDs were correct, check success message count |
| "Can't remove unlock" | Edit student, remove level name from list, save |
| "Want to undo" | Restore from backup (Admin → Backup → Restore) |

---

## 📞 Support Contacts

- **Technical Issues**: Contact system admin
- **Feature Questions**: Check ADMIN_LEVEL_UNLOCK_FEATURE_GUIDE.md
- **API Help**: See TECHNICAL_IMPLEMENTATION_GUIDE.md

---

## 🎯 Key Remember Points

1️⃣ **Beginner is always open** - no unlock needed

2️⃣ **Unlock adds to existing** - doesn't replace
- If student has [Elementary], unlocking Pre-Intermediate gives [Elementary, Pre-Intermediate]

3️⃣ **Student can earn levels naturally** - unlock is optional
- They can pass tests to earn access
- Unlock just bypasses that requirement

4️⃣ **Permanent unless you change it** - no expiration

5️⃣ **Works immediately** - student sees it after refresh

---

## 📱 Mobile Admin App Access

The admin panel works on mobile:
- Go to: `http://localhost:5173/admin` on mobile
- Login with your admin account
- Use bulk actions for fastest results on small screen

---

## 🔐 Security Notes

- Only admins can unlock levels
- Each action is logged and tracked
- Student cannot unlock for themselves
- Admin cannot unlock for other admins
- Backups save unlock status (can be restored)

---

**Last Updated**: 2024-06-20
**Version**: 1.0
**Status**: Ready to Use ✅

For detailed info: See full guides in documentation folder
For quick answers: Check scenarios above
