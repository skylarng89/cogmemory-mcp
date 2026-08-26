// Sample Go file for verifying go-analyzer end-to-end through the MCP pipeline
package greeter

import (
	"fmt"
	"strings"
)

// Person is a struct representing a person.
type Person struct {
	Name string
	Age  int
}

// Greeter embeds Person and adds a greeting method.
type Greeter struct {
	Person
	prefix string
}

// GreeterInterface defines the greeting contract.
type GreeterInterface interface {
	Greet() string
}

// NewGreeter creates a Greeter with a default prefix.
func NewGreeter(name string, age int) *Greeter {
	return &Greeter{
		Person: Person{Name: name, Age: age},
		prefix: "Hello",
	}
}

// Greet returns the greeting string.
func (g *Greeter) Greet() string {
	return fmt.Sprintf("%s, %s!", g.prefix, g.Name)
}

// UpperGreet converts the greeting to uppercase.
func (g *Greeter) UpperGreet() string {
	return strings.ToUpper(g.Greet())
}

// defaultPrefix is an unexported variable.
var defaultPrefix = "Hi"

// MaxAge is an exported constant.
const MaxAge = 150
