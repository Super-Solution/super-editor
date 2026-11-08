// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC

// Package server implements the Super Editor actions and the HTTP API over the Go editor. The TypeScript package
// defines the contract; the data it generates (action schemas, templates, routes, OpenAPI) is embedded in spec.json.
package server

import (
	_ "embed"
	"fmt"
	"sync"

	"github.com/Super-Solution/super-editor/backends/go/validation"
)

//go:embed spec.json
var specJSON []byte

type routeSpec struct {
	Method      string
	Path        string
	OperationID string
	Summary     string
	Description string
	Tag         string
	Write       bool
	Legacy      bool
	Query       []queryParam
	Body        string
}

type queryParam struct {
	Name     string
	Field    string
	Type     string
	Enum     []string
	Nullable bool
}

type actionSpec struct {
	Name        string
	Title       string
	Description string
	Access      string
	Destructive bool
	Idempotent  bool
	InputSchema *validation.Object
	Raw         *validation.Object
}

type specData struct {
	root           *validation.Object
	limits         map[string]float64
	actions        []*actionSpec
	actionByName   map[string]*actionSpec
	routes         []*routeSpec
	documentSchema *validation.Object
	txSchema       *validation.Object
	openapi        *validation.Object
	templateKinds  []string
	templateInfos  []any
	templateTitles map[string]string
	templates      map[string]*validation.Object
}

var (
	specOnce sync.Once
	specVal  *specData
)

func spec() *specData {
	specOnce.Do(func() {
		decoded, err := validation.Decode(specJSON)
		if err != nil {
			panic(fmt.Sprintf("server: spec.json is not valid JSON: %v", err))
		}
		root := decoded.(*validation.Object)
		s := &specData{root: root, limits: map[string]float64{}, actionByName: map[string]*actionSpec{}, templateTitles: map[string]string{}, templates: map[string]*validation.Object{}}
		for k, v := range get(root, "limits").(*validation.Object).Values {
			s.limits[k] = v.(float64)
		}
		for _, a := range get(root, "actions").([]any) {
			o := a.(*validation.Object)
			action := &actionSpec{
				Name: str(o, "name"), Title: str(o, "title"), Description: str(o, "description"), Access: str(o, "access"),
				Destructive: boolOf(o, "destructive"), Idempotent: boolOf(o, "idempotent"), InputSchema: get(o, "inputSchema").(*validation.Object), Raw: o,
			}
			s.actions = append(s.actions, action)
			s.actionByName[action.Name] = action
		}
		for _, r := range get(root, "routes").([]any) {
			o := r.(*validation.Object)
			route := &routeSpec{
				Method: str(o, "method"), Path: str(o, "path"), OperationID: str(o, "operationId"), Summary: str(o, "summary"),
				Description: str(o, "description"), Tag: str(o, "tag"), Write: boolOf(o, "write"), Legacy: boolOf(o, "legacy"), Body: str(o, "body"),
			}
			if q, ok := o.Get("query"); ok {
				for _, e := range q.([]any) {
					p := e.(*validation.Object)
					param := queryParam{Name: str(p, "name"), Field: str(p, "field"), Type: str(p, "type"), Nullable: boolOf(p, "nullable")}
					if en, ok := p.Get("enum"); ok {
						for _, v := range en.([]any) {
							param.Enum = append(param.Enum, v.(string))
						}
					}
					route.Query = append(route.Query, param)
				}
			}
			s.routes = append(s.routes, route)
		}
		s.documentSchema = get(root, "documentSchema").(*validation.Object)
		s.txSchema = get(root, "transactionSchema").(*validation.Object)
		s.openapi = get(root, "openapi").(*validation.Object)
		for _, k := range get(root, "templateKinds").([]any) {
			s.templateKinds = append(s.templateKinds, k.(string))
		}
		s.templateInfos = get(root, "templateInfos").([]any)
		for k, v := range get(root, "templateTitles").(*validation.Object).Values {
			s.templateTitles[k] = v.(string)
		}
		for k, v := range get(root, "templates").(*validation.Object).Values {
			s.templates[k] = v.(*validation.Object)
		}
		specVal = s
	})
	return specVal
}

func get(o *validation.Object, key string) any { v, _ := o.Get(key); return v }

func str(o *validation.Object, key string) string { s, _ := get(o, key).(string); return s }

func boolOf(o *validation.Object, key string) bool { b, _ := get(o, key).(bool); return b }

func limit(name string) int { return int(spec().limits[name]) }
