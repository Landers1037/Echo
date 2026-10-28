package app

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

type Plan struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Note      string `json:"note,omitempty"`
	Repeat    string `json:"repeat"`
	Date      string `json:"date,omitempty"`
	Time      string `json:"time"`
	Weekdays  []int  `json:"weekdays,omitempty"`
	Timezone  string `json:"timezone,omitempty"`
	Enabled   bool   `json:"enabled"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func planLocation(timezone string) (*time.Location, error) {
	if timezone == "" || timezone == "Local" {
		return time.Local, nil
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, fmt.Errorf("无效时区: %s", timezone)
	}
	return location, nil
}

func normalizeClock(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) == 4 && value[1] == ':' {
		value = "0" + value
	}
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		return "", fmt.Errorf("提醒时间格式无效")
	}
	return parsed.Format("15:04"), nil
}

func normalizeDate(value string) (string, error) {
	parsed, err := time.Parse("2006-01-02", strings.TrimSpace(value))
	if err != nil {
		return "", fmt.Errorf("请设置提醒日期")
	}
	return parsed.Format("2006-01-02"), nil
}

func normalizeWeekdays(days []int) ([]int, error) {
	if len(days) == 0 {
		return nil, fmt.Errorf("请至少选择一天")
	}
	seen := map[int]bool{}
	normalized := make([]int, 0, len(days))
	for _, day := range days {
		if day < 0 || day > 6 {
			return nil, fmt.Errorf("无效的星期")
		}
		if seen[day] {
			continue
		}
		seen[day] = true
		normalized = append(normalized, day)
	}
	sort.Ints(normalized)
	return normalized, nil
}

func validatePlan(plan *Plan) error {
	plan.Title = strings.TrimSpace(plan.Title)
	plan.Note = strings.TrimSpace(plan.Note)
	if plan.Title == "" {
		return fmt.Errorf("计划标题不能为空")
	}
	if plan.Repeat != "once" && plan.Repeat != "daily" && plan.Repeat != "weekly" {
		return fmt.Errorf("无效的重复规则")
	}
	clock, err := normalizeClock(plan.Time)
	if err != nil {
		return err
	}
	plan.Time = clock
	timezone := strings.TrimSpace(plan.Timezone)
	if timezone == "" {
		timezone = "Local"
	}
	if _, err = planLocation(timezone); err != nil {
		return err
	}
	plan.Timezone = timezone
	switch plan.Repeat {
	case "once":
		date, err := normalizeDate(plan.Date)
		if err != nil {
			return err
		}
		plan.Date = date
		plan.Weekdays = nil
	case "daily":
		plan.Date = ""
		plan.Weekdays = nil
	case "weekly":
		days, err := normalizeWeekdays(plan.Weekdays)
		if err != nil {
			return err
		}
		plan.Date = ""
		plan.Weekdays = days
	}
	return nil
}

func parseInstant(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, fmt.Errorf("缺少时间")
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed, nil
	}
	return time.Parse(time.RFC3339, value)
}

func hasWeekday(days []int, day int) bool {
	for _, value := range days {
		if value == day {
			return true
		}
	}
	return false
}

// latestOccurrence 返回不早于计划创建时间、且不晚于 now 的最近一次提醒。
// 长时间未打开时只补这一次，避免按天积压出大量提醒。
func latestOccurrence(plan Plan, now time.Time) (time.Time, bool) {
	location, err := planLocation(plan.Timezone)
	if err != nil {
		return time.Time{}, false
	}
	clock, err := time.Parse("15:04", plan.Time)
	if err != nil {
		return time.Time{}, false
	}
	created, err := parseInstant(plan.CreatedAt)
	if err != nil {
		return time.Time{}, false
	}
	localNow := now.In(location)
	at := func(day time.Time) time.Time {
		return time.Date(day.Year(), day.Month(), day.Day(), clock.Hour(), clock.Minute(), 0, 0, location)
	}
	accept := func(candidate time.Time) (time.Time, bool) {
		if candidate.After(now) || candidate.Before(created) {
			return time.Time{}, false
		}
		return candidate, true
	}
	switch plan.Repeat {
	case "once":
		day, err := time.ParseInLocation("2006-01-02", plan.Date, location)
		if err != nil {
			return time.Time{}, false
		}
		return accept(at(day))
	case "daily":
		candidate := at(localNow)
		if candidate.After(now) {
			candidate = candidate.AddDate(0, 0, -1)
		}
		return accept(candidate)
	case "weekly":
		for i := 0; i <= 7; i++ {
			candidate := at(localNow.AddDate(0, 0, -i))
			if candidate.After(now) || !hasWeekday(plan.Weekdays, int(candidate.Weekday())) {
				continue
			}
			return accept(candidate)
		}
	}
	return time.Time{}, false
}

func (s *Store) createPlan(input Plan) (Plan, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	input.ID = newID()
	input.Enabled = true
	input.CreatedAt = now
	input.UpdatedAt = now
	if err := validatePlan(&input); err != nil {
		return Plan{}, err
	}
	old := append([]Plan{}, s.state.Plans...)
	s.state.Plans = append(s.state.Plans, input)
	if err := s.persist(); err != nil {
		s.state.Plans = old
		return Plan{}, err
	}
	return input, nil
}

func (s *Store) updatePlan(input Plan) (Plan, error) {
	index := -1
	for i := range s.state.Plans {
		if input.ID != "" && s.state.Plans[i].ID == input.ID {
			index = i
			break
		}
	}
	if index < 0 {
		return Plan{}, fmt.Errorf("计划不存在")
	}
	current := s.state.Plans[index]
	input.CreatedAt = current.CreatedAt
	input.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if strings.TrimSpace(input.Timezone) == "" {
		input.Timezone = current.Timezone
	}
	if err := validatePlan(&input); err != nil {
		return Plan{}, err
	}
	old := append([]Plan{}, s.state.Plans...)
	s.state.Plans[index] = input
	if err := s.persist(); err != nil {
		s.state.Plans = old
		return Plan{}, err
	}
	return input, nil
}

func (s *Store) deletePlan(id string) error {
	next := make([]Plan, 0, len(s.state.Plans))
	found := false
	for _, plan := range s.state.Plans {
		if plan.ID == id {
			found = true
			continue
		}
		next = append(next, plan)
	}
	if !found {
		return fmt.Errorf("计划不存在")
	}
	old := s.state.Plans
	s.state.Plans = next
	if err := s.persist(); err != nil {
		s.state.Plans = old
		return err
	}
	return nil
}
